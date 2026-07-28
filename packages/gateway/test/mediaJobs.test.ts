import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ServerResponse } from 'node:http';
import type {
  ITranslateTransport, NormalizedEvent, RawDirection, ServerEvent, SessionConfig,
} from '@livetranslate/core';
import { openDb, type Db } from '../src/db';
import { Storage } from '../src/storage';
import { SettingsStore, type KeyStore } from '../src/settings';
import { logFilePath } from '../src/historyRoutes';
import { jobProgress, processMediaJob, registerMediaRoutes, type MediaDeps } from '../src/mediaJobs';
import type { RouteHandler } from '../src/server';

class MemKeyStore implements KeyStore {
  private key: string | null = null;
  getKey(): string | null { return this.key; }
  setKey(key: string): void { this.key = key; }
  clearKey(): void { this.key = null; }
}

// 与 core/test/filePipeline.test.ts 同款脚本回放传输：finish() 时回放归一化事件，
// 并通过 onRaw 补发原始 session.created（processMediaJob 靠它拿 session id 开日志 sink）。
class ScriptedTransport implements ITranslateTransport {
  readonly kind = 'ws' as const;
  appendedChunks = 0;
  private handlers = new Map<string, Set<(ev: NormalizedEvent) => void>>();
  private rawTaps = new Set<(dir: RawDirection, payload: ServerEvent) => void>();
  constructor(private script: NormalizedEvent[]) {}
  connect(_cfg: SessionConfig): Promise<void> {
    this.rawTaps.forEach((cb) => cb('s2c', { type: 'session.created', session: { id: 'sess_media_1' } } as ServerEvent));
    return Promise.resolve();
  }
  updateSession(): Promise<void> { return Promise.resolve(); }
  appendAudio(): void { this.appendedChunks++; }
  appendImage(): void {}
  finish(): Promise<void> {
    for (const ev of this.script) {
      this.rawTaps.forEach((cb) => cb('s2c', { type: `replay.${ev.kind}` } as ServerEvent));
      this.handlers.get(ev.kind)?.forEach((cb) => cb(ev));
    }
    return Promise.resolve();
  }
  abort(): void {}
  on(kind: string, cb: (ev: never) => void): () => void {
    if (!this.handlers.has(kind)) this.handlers.set(kind, new Set());
    const set = this.handlers.get(kind)!;
    set.add(cb as (ev: NormalizedEvent) => void);
    return () => set.delete(cb as (ev: NormalizedEvent) => void);
  }
  onRaw(cb: (dir: RawDirection, payload: ServerEvent) => void): () => void {
    this.rawTaps.add(cb);
    return () => this.rawTaps.delete(cb);
  }
  getRemoteAudio(): MediaStream | null { return null; }
}

// 与 T21 core 测试同一份真实回放脚本（usage 累积值 169，63 字节 24k 音频）
const SCRIPT: NormalizedEvent[] = [
  { kind: 'session-created', sessionId: 'sess_media_1' },
  { kind: 'session-updated' },
  { kind: 'speech-started', itemId: 'item_f1', audioStartMs: 0 },
  { kind: 'asr-delta', itemId: 'item_f1', text: '今天天气很好，', stash: '我们', language: 'zh', emotion: 'neutral' },
  { kind: 'response-created', responseId: 'resp_f1' },
  { kind: 'translation-delta', responseId: 'resp_f1', text: 'The weather is very nice today,', stash: " let's" },
  { kind: 'audio-delta', responseId: 'resp_f1', base64: 'AdaB2YHlwfIF/gL4Adj/3P7g/+MBxwHZAtkA2P/G/7v/xACWAJUBhQGcAK7/pP6q/qb/PACJAF4AegDsAG8A' },
  { kind: 'speech-stopped', itemId: 'item_f1', audioEndMs: 4600 },
  { kind: 'asr-completed', itemId: 'item_f1', transcript: '今天天气很好，我们一起去公园散步。', language: 'zh', emotion: 'neutral' },
  { kind: 'translation-done', responseId: 'resp_f1', text: "The weather is very nice today, let's go for a walk in the park together.  " },
  {
    kind: 'response-done', responseId: 'resp_f1',
    usage: {
      total_tokens: 169, input_tokens: 85, output_tokens: 84,
      input_tokens_details: { text_tokens: 50, audio_tokens: 35 },
      output_tokens_details: { text_tokens: 33, audio_tokens: 51 },
    },
  },
  { kind: 'session-finished' },
];

function fakeRes() {
  const chunks: string[] = [];
  let statusCode = 0;
  const res = {
    writeHead: (code: number) => { statusCode = code; return res; },
    end: (data?: string) => { if (data !== undefined) chunks.push(data); },
  } as unknown as ServerResponse;
  return { res, json: () => JSON.parse(chunks.join('')) as Record<string, unknown>, status: () => statusCode };
}

let dataDir: string;
let db: Db;
let deps: MediaDeps;
let ranJobs: string[];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'lt-media-'));
  ranJobs = [];
  db = openDb(join(dataDir, 'app.db'));
  deps = {
    storage: new Storage(db, dataDir),
    settings: new SettingsStore(join(dataDir, 'settings.json'), new MemKeyStore()),
    dataDir,
    // 同步落盘的 sink，测试断言无需等待流刷新
    logFiles: {
      sinkFor: (sessionId: string) => {
        const file = logFilePath(dataDir, sessionId);
        mkdirSync(dirname(file), { recursive: true });
        return (line: string) => appendFileSync(file, `${line}\n`);
      },
    },
    runner: (jobId) => ranJobs.push(jobId),
  };
});

// Windows：先关 SQLite 句柄再删临时目录，否则 rmSync EPERM
afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('registerMediaRoutes', () => {
  it('POST /media-jobs saves upload, inserts pending row and kicks runner', () => {
    const routes = new Map<string, RouteHandler>();
    registerMediaRoutes(routes, deps);
    const { res, json, status } = fakeRes();
    void routes.get('POST /media-jobs')!({} as never, res, JSON.stringify({
      fileName: 'talk.mp3', dataBase64: Buffer.from('fake-mp3-bytes').toString('base64'),
      isVideo: false, targetLanguage: 'en', voiceClone: false, voice: 'Tina', framesEnabled: false,
    }));
    expect(status()).toBe(200);
    const jobId = json().jobId as string;
    expect(ranJobs).toEqual([jobId]);
    const row = deps.storage.getMediaJob(jobId)!;
    expect(row.status).toBe('pending');
    expect(row.source_path).toBe(join(dataDir, 'media', jobId, 'talk.mp3'));
    expect(readFileSync(row.source_path, 'utf8')).toBe('fake-mp3-bytes');
    expect(JSON.parse(row.frame_config_json)).toEqual({
      isVideo: false, framesEnabled: false, fps: 1, sourceLanguage: null,
      targetLanguage: 'en', voiceClone: false, voice: 'Tina',
    });
  });

  it('GET /media-job returns row + progress, 404 when missing', () => {
    const routes = new Map<string, RouteHandler>();
    registerMediaRoutes(routes, deps);
    deps.storage.insertMediaJob({ id: 'job_g', sourcePath: '/x', frameConfigJson: '{}', createdAt: 1 });
    jobProgress.set('job_g', { doneMs: 4600, totalMs: 9000 });
    const ok = fakeRes();
    void routes.get('GET /media-job')!({ url: '/media-job?id=job_g' } as never, ok.res, '');
    expect(ok.status()).toBe(200);
    expect((ok.json().job as { id: string }).id).toBe('job_g');
    expect(ok.json().progress).toEqual({ doneMs: 4600, totalMs: 9000 });
    const miss = fakeRes();
    void routes.get('GET /media-job')!({ url: '/media-job?id=nope' } as never, miss.res, '');
    expect(miss.status()).toBe(404);
  });
});

describe('processMediaJob', () => {
  it('runs full-speed pipeline, persists filedub session/segments/wav/log and marks done', async () => {
    deps.storage.insertMediaJob({
      id: 'job_p', sourcePath: join(dataDir, 'in.wav'),
      frameConfigJson: JSON.stringify({
        isVideo: false, framesEnabled: false, fps: 1, sourceLanguage: null,
        targetLanguage: 'en', voiceClone: true, voice: 'Tina',
      }),
      createdAt: 1,
    });
    const t = new ScriptedTransport(SCRIPT);
    await processMediaJob(deps, 'job_p', {
      extract: () => Promise.resolve({ pcm16k: new Uint8Array(32000), frames: [] }), // 1000ms → 10 块
      transportFactory: () => t,
    });
    expect(t.appendedChunks).toBe(10); // P7/P8：3200 字节/块、全速推完

    const job = deps.storage.getMediaJob('job_p')!;
    expect(job.status).toBe('done');
    expect(job.session_id).toBe('sess_media_1'); // 服务端 session id 与日志/落库同键
    expect(JSON.parse(job.artifacts_json!)).toEqual({ totalMs: 1000, segmentCount: 1 });

    const session = deps.storage.getSession('sess_media_1')!;
    expect(session.mode).toBe('filedub');
    expect((JSON.parse(session.usage_json!) as { total_tokens: number }).total_tokens).toBe(169);
    // P10：once 复刻时 voice 必须为 "default"
    const cfg = JSON.parse(session.config_json) as SessionConfig;
    expect(cfg.voice).toBe('default');
    expect(cfg.voice_clone_options).toEqual({ frequency: 'once' });

    const segs = deps.storage.listSegments('sess_media_1');
    expect(segs.length).toBe(1);
    expect(segs[0]!.target_text).toBe("The weather is very nice today, let's go for a walk in the park together.  ");
    expect(segs[0]!.audio_path).not.toBeNull();
    expect(readFileSync(segs[0]!.audio_path!).length).toBe(44 + 63); // WAV 头 + 63 字节 24k PCM（P9；计划勘误 84 字符 base64 = 63 字节）

    const logRow = deps.storage.getSessionLog('sess_media_1')!;
    expect(existsSync(logRow.file_path)).toBe(true);
    expect(logRow.event_count).toBe(1 + SCRIPT.length); // 原始 session.created + 回放事件
    expect(logRow.error_count).toBe(0);
  });

  it('marks job failed and records error when pipeline throws', async () => {
    deps.storage.insertMediaJob({
      id: 'job_f', sourcePath: join(dataDir, 'missing.wav'),
      frameConfigJson: JSON.stringify({
        isVideo: false, framesEnabled: false, fps: 1, sourceLanguage: null,
        targetLanguage: 'en', voiceClone: false, voice: 'Tina',
      }),
      createdAt: 1,
    });
    await processMediaJob(deps, 'job_f', {
      extract: () => Promise.reject(new Error('ffmpeg exited with code 1')),
    });
    const job = deps.storage.getMediaJob('job_f')!;
    expect(job.status).toBe('failed');
    expect(JSON.parse(job.artifacts_json!)).toEqual({ error: 'Error: ffmpeg exited with code 1' });
  });
});
