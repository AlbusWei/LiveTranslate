import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db';
import { Storage } from '../src/storage';

let storage: Storage;
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'lt-store-'));
  storage = new Storage(openDb(join(dataDir, 'app.db')), dataDir);
});

describe('Storage', () => {
  it('creates a session and finishes it with cumulative usage', () => {
    storage.createSession({ id: 'sess_1', mode: 'solo', configJson: '{"translation":{"language":"en"}}', startedAt: 1000 });
    storage.finishSession('sess_1', { endedAt: 2000, usageJson: '{"total_tokens":972}' });
    const s = storage.getSession('sess_1');
    expect(s?.mode).toBe('solo');
    expect(s?.ended_at).toBe(2000);
    expect(JSON.parse(s!.usage_json!)).toEqual({ total_tokens: 972 });
  });

  it('saves segments with audio file and lists them ordered by seq', () => {
    storage.createSession({ id: 'sess_2', mode: 'solo', configJson: '{}', startedAt: 0 });
    const audioPath = storage.saveSegmentAudio('sess_2', 1, new Uint8Array([1, 2, 3, 4]));
    expect(existsSync(audioPath)).toBe(true);
    expect(audioPath.endsWith(join('audio', 'sess_2', '1.wav'))).toBe(true);
    storage.insertSegment({
      sessionId: 'sess_2', seq: 1, vadStartMs: 0, vadEndMs: 4600,
      sourceText: '今天天气很好，我们一起去公园散步。',
      targetText: "The weather is very nice today, let's go for a walk in the park together.  ",
      sourceLang: 'zh', emotion: 'neutral', audioPath, usageJson: '{"total_tokens":118}',
    });
    const segs = storage.listSegments('sess_2');
    expect(segs.length).toBe(1);
    expect(segs[0]!.audio_path).toBe(audioPath);
  });

  it('lists sessions by mode, newest first', () => {
    storage.createSession({ id: 'a', mode: 'solo', configJson: '{}', startedAt: 1 });
    storage.createSession({ id: 'b', mode: 'filedub', configJson: '{}', startedAt: 2 });
    storage.createSession({ id: 'c', mode: 'solo', configJson: '{}', startedAt: 3 });
    expect(storage.listSessions('solo').map((s) => s.id)).toEqual(['c', 'a']);
    expect(storage.listSessions().map((s) => s.id)).toEqual(['c', 'b', 'a']);
  });

  it('session_logs index row (spec 6.6) upserts and reads back', () => {
    storage.upsertSessionLog({ sessionId: 'sess_3', filePath: '/logs/sessions/sess_3.jsonl', mode: 'solo', startedAt: 1, endedAt: 9, eventCount: 49, errorCount: 0 });
    const row = storage.getSessionLog('sess_3');
    expect(row?.event_count).toBe(49);
    storage.upsertSessionLog({ sessionId: 'sess_3', filePath: '/logs/sessions/sess_3.jsonl', mode: 'solo', startedAt: 1, endedAt: 20, eventCount: 80, errorCount: 1 });
    expect(storage.getSessionLog('sess_3')?.event_count).toBe(80);
  });

  it('deleteSession removes segments too', () => {
    storage.createSession({ id: 'd', mode: 'solo', configJson: '{}', startedAt: 1 });
    storage.insertSegment({ sessionId: 'd', seq: 1, vadStartMs: 0, vadEndMs: 100, sourceText: 'x', targetText: 'y', sourceLang: null, emotion: null, audioPath: null, usageJson: null });
    storage.deleteSession('d');
    expect(storage.getSession('d')).toBeUndefined();
    expect(storage.listSegments('d')).toEqual([]);
  });

  it('media_jobs: pending → processing → done with artifacts (spec 5.2)', () => {
    storage.insertMediaJob({ id: 'job_1', sourcePath: '/media/job_1/in.mp4', frameConfigJson: '{"framesEnabled":true,"fps":1}', createdAt: 42 });
    expect(storage.getMediaJob('job_1')?.status).toBe('pending');
    storage.updateMediaJob('job_1', { status: 'processing' });
    expect(storage.getMediaJob('job_1')?.status).toBe('processing');
    storage.updateMediaJob('job_1', { status: 'done', sessionId: 'sess_j1', artifactsJson: '{"segmentCount":3}' });
    const row = storage.getMediaJob('job_1')!;
    expect(row.status).toBe('done');
    expect(row.session_id).toBe('sess_j1');
    expect(JSON.parse(row.artifacts_json!)).toEqual({ segmentCount: 3 });
    expect(storage.getMediaJob('nope')).toBeNull();
  });
});
