import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { BYTES_PER_MS_24K, OUTPUT_SAMPLE_RATE, pcm16ToWav } from '@livetranslate/core';
import { openDb, type Db } from '../src/db';
import { Storage } from '../src/storage';
import { registerExportRoutes } from '../src/exportRoutes';
import type { RouteHandler } from '../src/server';

function fakeRes() {
  const chunks: Array<string | Buffer> = [];
  let statusCode = 0;
  let headers: Record<string, string> = {};
  const res = {
    writeHead: (code: number, h?: Record<string, string>) => { statusCode = code; headers = h ?? {}; return res; },
    end: (data?: string | Buffer) => { if (data !== undefined) chunks.push(data); },
  } as unknown as ServerResponse;
  return {
    res,
    text: () => chunks.map((c) => c.toString()).join(''),
    bytes: () => Buffer.concat(chunks.map((c) => Buffer.from(c))),
    status: () => statusCode,
    headers: () => headers,
  };
}

let dataDir: string;
let db: Db;
let storage: Storage;
let routes: Map<string, RouteHandler>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'lt-export-'));
  db = openDb(join(dataDir, 'app.db'));
  storage = new Storage(db, dataDir);
  routes = new Map();
  registerExportRoutes(routes, { storage });

  storage.createSession({ id: 'sess_e1', mode: 'filedub', configJson: '{}', startedAt: 1 });
  // seq0：译文 1000ms；seq1：译文 4000ms（长于原段，验证顺延只影响 WAV、不影响 SRT）
  const wav0 = pcm16ToWav(new Uint8Array(1000 * BYTES_PER_MS_24K).fill(7), OUTPUT_SAMPLE_RATE);
  const wav1 = pcm16ToWav(new Uint8Array(4000 * BYTES_PER_MS_24K).fill(8), OUTPUT_SAMPLE_RATE);
  const p0 = storage.saveSegmentAudio('sess_e1', 0, wav0);
  const p1 = storage.saveSegmentAudio('sess_e1', 1, wav1);
  storage.insertSegment({
    sessionId: 'sess_e1', seq: 0, vadStartMs: 0, vadEndMs: 2000,
    sourceText: '今天天气很好。', targetText: 'Nice weather today.', sourceLang: 'zh', emotion: 'neutral',
    audioPath: p0, usageJson: null,
  });
  storage.insertSegment({
    sessionId: 'sess_e1', seq: 1, vadStartMs: 2000, vadEndMs: 5000,
    sourceText: '第二句。', targetText: 'Second sentence.', sourceLang: 'zh', emotion: 'neutral',
    audioPath: p1, usageJson: null,
  });
});

// Windows：先关 SQLite 句柄再删临时目录，否则 rmSync EPERM
afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('registerExportRoutes (spec 5.2 导出)', () => {
  it('GET /export/srt renders cues on the original timeline', () => {
    const r = fakeRes();
    void routes.get('GET /export/srt')!({ url: '/export/srt?sessionId=sess_e1' } as never, r.res, '');
    expect(r.status()).toBe(200);
    expect(r.headers()['Content-Type']).toBe('text/plain; charset=utf-8');
    expect(r.text()).toBe([
      '1', '00:00:00,000 --> 00:00:02,000', 'Nice weather today.', '',
      '2', '00:00:02,000 --> 00:00:05,000', 'Second sentence.', '',
    ].join('\n'));
  });

  it('GET /export/txt renders bilingual blocks', () => {
    const r = fakeRes();
    void routes.get('GET /export/txt')!({ url: '/export/txt?sessionId=sess_e1' } as never, r.res, '');
    expect(r.text()).toBe('今天天气很好。\nNice weather today.\n\n第二句。\nSecond sentence.\n');
  });

  it('GET /export/dub-wav mixes segments on the drift timeline', () => {
    const r = fakeRes();
    void routes.get('GET /export/dub-wav')!({ url: '/export/dub-wav?sessionId=sess_e1' } as never, r.res, '');
    const wav = r.bytes();
    expect(r.headers()['Content-Type']).toBe('audio/wav');
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    // seq1 尾部顺延到 2000+4000=6000ms → data 长 6000*48
    expect(wav.length).toBe(44 + 6000 * BYTES_PER_MS_24K);
    expect(wav[44]).toBe(7); // seq0 起点
    expect(wav[44 + 1000 * BYTES_PER_MS_24K]).toBe(0); // 1000–2000ms 静音
    expect(wav[44 + 2000 * BYTES_PER_MS_24K]).toBe(8); // seq1 贴原起点 2000ms
  });

  it('returns 404 for unknown session', () => {
    const r = fakeRes();
    void routes.get('GET /export/srt')!({ url: '/export/srt?sessionId=nope' } as never, r.res, '');
    expect(r.status()).toBe(404);
  });
});
