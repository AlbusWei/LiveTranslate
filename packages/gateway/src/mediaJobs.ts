import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ServerResponse } from 'node:http';
import {
  OUTPUT_SAMPLE_RATE, SessionLogger, WsTransport, pcm16ToWav, runFilePipeline,
  type ITranslateTransport, type PipelineFrame, type RawDirection, type ServerEvent,
  type SessionConfig, type WsLike,
} from '@livetranslate/core';
import WebSocket from 'ws';
import { extractFrames, extractPcm16k } from './ffmpeg';
import { logFilePath } from './historyRoutes';
import type { RouteHandler } from './server';
import type { SessionLogFiles } from './logFiles';
import type { SettingsStore } from './settings';
import type { Storage } from './storage';

const MODEL = 'qwen3.5-livetranslate-flash-realtime';

// 持久化在 media_jobs.frame_config_json 里的作业配置（含抽帧与翻译参数）
export interface MediaJobConfig {
  isVideo: boolean;
  framesEnabled: boolean; // spec 5.2：抽帧视觉增强开关（默认开，仅视频生效）
  fps: 1 | 2;
  sourceLanguage: string | null;
  targetLanguage: string;
  voiceClone: boolean; // spec 5.2：once 复刻
  voice: string;
}

export interface MediaJobRequest {
  fileName: string;
  dataBase64: string;
  isVideo: boolean;
  sourceLanguage?: string; // 缺省 = 自动检测
  targetLanguage: string;
  voiceClone: boolean;
  voice: string;
  framesEnabled: boolean;
}

export interface MediaJobProgress { doneMs: number; totalMs: number }

// 进度只存内存（桌面单机体量小）；完成后 UI 改读 artifacts_json
export const jobProgress = new Map<string, MediaJobProgress>();

export interface MediaDeps {
  storage: Storage;
  settings: SettingsStore;
  dataDir: string;
  logFiles: Pick<SessionLogFiles, 'sinkFor'>;
  runner?: (jobId: string) => void; // 测试注入；默认 fire-and-forget processMediaJob
}

// P1：文件模式在网关进程内直连上游（不经 /realtime 中继），Key 仅在这里出现
export function nodeWsFactory(apiKey: string): (url: string) => WsLike {
  return (url) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    const like: WsLike = {
      send: (data) => ws.send(data),
      close: () => ws.close(),
      onopen: null, onmessage: null, onclose: null, onerror: null,
    };
    ws.on('open', () => like.onopen?.());
    ws.on('message', (data) => like.onmessage?.(String(data)));
    ws.on('close', () => like.onclose?.());
    ws.on('error', (err) => like.onerror?.(err));
    return like;
  };
}

export interface ProcessOverrides {
  extract?: (sourcePath: string, cfg: MediaJobConfig) => Promise<{ pcm16k: Uint8Array; frames: PipelineFrame[] }>;
  transportFactory?: () => ITranslateTransport;
}

async function defaultExtract(sourcePath: string, cfg: MediaJobConfig): Promise<{ pcm16k: Uint8Array; frames: PipelineFrame[] }> {
  const pcm16k = await extractPcm16k(sourcePath);
  let frames: PipelineFrame[] = [];
  if (cfg.isVideo && cfg.framesEnabled) {
    const extracted = await extractFrames(sourcePath, { fps: cfg.fps, workDir: join(dirname(sourcePath), 'frames') });
    frames = extracted.map((f) => ({ timeMs: f.timeMs, jpegBase64: f.jpeg.toString('base64') }));
  }
  return { pcm16k, frames };
}

export async function processMediaJob(deps: MediaDeps, jobId: string, overrides: ProcessOverrides = {}): Promise<void> {
  const job = deps.storage.getMediaJob(jobId);
  if (!job) return;
  const cfg = JSON.parse(job.frame_config_json) as MediaJobConfig;
  deps.storage.updateMediaJob(jobId, { status: 'processing' });
  try {
    const { pcm16k, frames } = await (overrides.extract ?? defaultExtract)(job.source_path, cfg);
    const totalMs = Math.round(pcm16k.length / 32); // 32 字节/ms @16k16bit mono
    jobProgress.set(jobId, { doneMs: 0, totalMs });

    let transport: ITranslateTransport;
    if (overrides.transportFactory) {
      transport = overrides.transportFactory();
    } else {
      const host = deps.settings.get().workspaceHost;
      const key = deps.settings.getApiKey();
      if (!host || !key) throw new Error('gateway_not_configured：API Key 或 Workspace Host 未配置');
      transport = new WsTransport({
        url: `wss://${host}/api-ws/v1/realtime?model=${MODEL}`,
        wsFactory: nodeWsFactory(key),
      });
    }

    // spec 6.6：文件模式同样落全量事件日志；拿到服务端 session id 前先缓冲（同 relay 的 pending 模式）
    let logger: SessionLogger | null = null;
    let sessionId: string | null = null;
    const pending: Array<[RawDirection, ServerEvent]> = [];
    const offRaw = transport.onRaw((dir, payload) => {
      if (!logger) {
        if (payload.type === 'session.created') {
          sessionId = (payload as { session?: { id?: string } }).session?.id ?? `job_${jobId}`;
          logger = new SessionLogger({
            sink: deps.logFiles.sinkFor(sessionId),
            fullAudio: deps.settings.get().fullAudioLogs,
          });
          for (const [d, p] of pending) logger.record(d, p);
          pending.length = 0;
        } else {
          pending.push([dir, payload]);
          return;
        }
      }
      logger.record(dir, payload);
    });

    // P10：复刻时 voice 必须为 "default"；spec 5.2：配音用 once 复刻
    const sessionConfig: SessionConfig = {
      modalities: ['text', 'audio'],
      voice: cfg.voiceClone ? 'default' : cfg.voice,
      enable_voice_clone: cfg.voiceClone,
      ...(cfg.voiceClone ? { voice_clone_options: { frequency: 'once' as const } } : {}),
      sample_rate: 16000,
      input_audio_format: 'pcm',
      input_audio_transcription: {
        model: 'qwen3-asr-flash-realtime',
        ...(cfg.sourceLanguage ? { language: cfg.sourceLanguage } : {}),
      },
      translation: { language: cfg.targetLanguage },
    };

    const startedAt = Date.now();
    const result = await runFilePipeline({
      pcm16k, frames, config: sessionConfig, transport,
      onProgress: (doneMs, total) => jobProgress.set(jobId, { doneMs, totalMs: total }),
    });
    offRaw();

    // 落库与实时会话同构：HistoryPage/导出（T25）复用同一套数据
    const sid = sessionId ?? `job_${jobId}`;
    deps.storage.createSession({ id: sid, mode: 'filedub', configJson: JSON.stringify(sessionConfig), startedAt });
    for (const seg of result.segments) {
      const pcm24k = seg.responseId ? result.audioByResponseId.get(seg.responseId) : undefined;
      const audioPath = pcm24k
        ? deps.storage.saveSegmentAudio(sid, seg.seq, pcm16ToWav(pcm24k, OUTPUT_SAMPLE_RATE)) // P9：24k PCM → WAV
        : null;
      deps.storage.insertSegment({
        sessionId: sid, seq: seg.seq, vadStartMs: seg.vadStartMs, vadEndMs: seg.vadEndMs,
        sourceText: seg.sourceText, targetText: seg.targetText, sourceLang: seg.sourceLang,
        emotion: seg.emotion, audioPath, usageJson: seg.usage ? JSON.stringify(seg.usage) : null,
      });
    }
    const endedAt = Date.now();
    deps.storage.finishSession(sid, { endedAt, usageJson: JSON.stringify(result.usage.sessionTotal) });

    const file = logFilePath(deps.dataDir, sid);
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
      const errors = lines.filter((l) => (JSON.parse(l) as { type?: string }).type === 'error').length;
      deps.storage.upsertSessionLog({
        sessionId: sid, filePath: file, mode: 'filedub', startedAt, endedAt,
        eventCount: lines.length, errorCount: errors,
      });
    }

    deps.storage.updateMediaJob(jobId, {
      status: 'done', sessionId: sid,
      artifactsJson: JSON.stringify({ totalMs, segmentCount: result.segments.length }),
    });
  } catch (err) {
    deps.storage.updateMediaJob(jobId, { status: 'failed', artifactsJson: JSON.stringify({ error: String(err) }) });
  }
}

const json = (res: ServerResponse, code: number, payload: unknown): void => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
};

export function registerMediaRoutes(routes: Map<string, RouteHandler>, deps: MediaDeps): void {
  const runner = deps.runner ?? ((jobId: string) => { void processMediaJob(deps, jobId); });

  routes.set('POST /media-jobs', (_req, res, body) => {
    const b = JSON.parse(body) as MediaJobRequest;
    const jobId = randomUUID();
    const jobDir = join(deps.dataDir, 'media', jobId);
    mkdirSync(jobDir, { recursive: true });
    const sourcePath = join(jobDir, b.fileName);
    writeFileSync(sourcePath, Buffer.from(b.dataBase64, 'base64'));
    const cfg: MediaJobConfig = {
      isVideo: b.isVideo,
      framesEnabled: b.framesEnabled,
      fps: deps.settings.get().frameExtraction.fps,
      sourceLanguage: b.sourceLanguage ?? null,
      targetLanguage: b.targetLanguage,
      voiceClone: b.voiceClone,
      voice: b.voice,
    };
    deps.storage.insertMediaJob({ id: jobId, sourcePath, frameConfigJson: JSON.stringify(cfg), createdAt: Date.now() });
    runner(jobId);
    json(res, 200, { jobId });
  });

  routes.set('GET /media-job', (req, res) => {
    const id = new URL(req.url ?? '', 'http://gateway.local').searchParams.get('id') ?? '';
    const row = deps.storage.getMediaJob(id);
    if (!row) { json(res, 404, { error: 'job_not_found' }); return; }
    json(res, 200, { job: row, progress: jobProgress.get(id) ?? null });
  });

  // T23 双栏工作台播放原声用
  routes.set('GET /media-file', (req, res) => {
    const id = new URL(req.url ?? '', 'http://gateway.local').searchParams.get('id') ?? '';
    const row = deps.storage.getMediaJob(id);
    if (!row || !existsSync(row.source_path)) { json(res, 404, { error: 'file_not_found' }); return; }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    createReadStream(row.source_path).pipe(res);
  });
}
