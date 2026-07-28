import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGatewayServer, type GatewayHandle } from '../src/server';
import { SettingsStore, type KeyStore } from '../src/settings';

class MemKeyStore implements KeyStore {
  private key: string | null = null;
  getKey(): string | null { return this.key; }
  setKey(k: string): void { this.key = k; }
  clearKey(): void { this.key = null; }
}

describe('history routes (write side, spec 6.2/6.6)', () => {
  let dir: string;
  let gw: GatewayHandle;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lt-hist-'));
    const settings = new SettingsStore(join(dir, 'settings.json'), new MemKeyStore());
    gw = await createGatewayServer({ settings, dataDir: dir, port: 0 });
  });

  afterEach(async () => {
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`http://127.0.0.1:${gw.port}${path}`, { method: 'POST', body: JSON.stringify(body) });

  it('POST /sessions creates a session row readable via handle storage', async () => {
    const res = await post('/sessions', { id: 'sess_h1', mode: 'solo', configJson: '{}', startedAt: 1000 });
    expect(res.status).toBe(200);
    expect(gw.storage.getSession('sess_h1')?.mode).toBe('solo');
  });

  it('POST /segments stores wav bytes to audio dir and inserts segment row', async () => {
    await post('/sessions', { id: 'sess_h2', mode: 'solo', configJson: '{}', startedAt: 1000 });
    const wavBase64 = Buffer.from([0x52, 0x49, 0x46, 0x46]).toString('base64'); // 'RIFF'
    const res = await post('/segments', {
      sessionId: 'sess_h2', seq: 1, vadStartMs: 0, vadEndMs: 4600,
      sourceText: '今天天气很好，我们一起去公园散步。',
      targetText: "The weather is very nice today, let's go for a walk in the park together.  ",
      sourceLang: 'zh', emotion: 'neutral', usageJson: '{"total_tokens":169}', wavBase64,
    });
    expect(res.status).toBe(200);
    const segs = gw.storage.listSegments('sess_h2');
    expect(segs.length).toBe(1);
    expect(segs[0]!.audio_path?.endsWith(join('audio', 'sess_h2', '1.wav'))).toBe(true);
  });

  it('POST /sessions/finish sets ended_at/usage and upserts session_logs index from jsonl', async () => {
    await post('/sessions', { id: 'sess_h3', mode: 'solo', configJson: '{}', startedAt: 1000 });
    // 仿真 relay（T8）已写过的事件日志文件
    mkdirSync(join(dir, 'logs', 'sessions'), { recursive: true });
    writeFileSync(join(dir, 'logs', 'sessions', 'sess_h3.jsonl'),
      '{"ts":1,"dir":"c2s","type":"session.update","payload":{}}\n{"ts":2,"dir":"s2c","type":"error","payload":{}}\n');
    const res = await post('/sessions/finish', { id: 'sess_h3', endedAt: 9000, usageJson: '{"total_tokens":972}' });
    expect(res.status).toBe(200);
    expect(gw.storage.getSession('sess_h3')?.ended_at).toBe(9000);
    const log = gw.storage.getSessionLog('sess_h3');
    expect(log?.event_count).toBe(2);
    expect(log?.error_count).toBe(1);
  });
});

describe('history routes (read side, spec 6.2/6.6)', () => {
  let dir: string;
  let gw: GatewayHandle;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lt-hist-r-'));
    const settings = new SettingsStore(join(dir, 'settings.json'), new MemKeyStore());
    gw = await createGatewayServer({ settings, dataDir: dir, port: 0 });
  });

  afterEach(async () => {
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (path: string): Promise<Response> => fetch(`http://127.0.0.1:${gw.port}${path}`);

  it('GET /sessions lists newest first and filters by mode', async () => {
    gw.storage.createSession({ id: 'old', mode: 'solo', configJson: '{}', startedAt: 1000 });
    gw.storage.createSession({ id: 'new', mode: 'solo', configJson: '{}', startedAt: 2000 });
    gw.storage.createSession({ id: 'dub', mode: 'filedub', configJson: '{}', startedAt: 3000 });
    const all = await (await get('/sessions')).json() as { sessions: Array<{ id: string }> };
    expect(all.sessions.map((s) => s.id)).toEqual(['dub', 'new', 'old']);
    const solo = await (await get('/sessions?mode=solo')).json() as { sessions: Array<{ id: string }> };
    expect(solo.sessions.map((s) => s.id)).toEqual(['new', 'old']);
  });

  it('GET /segments returns rows for a session', async () => {
    gw.storage.createSession({ id: 's1', mode: 'solo', configJson: '{}', startedAt: 1000 });
    gw.storage.insertSegment({ sessionId: 's1', seq: 1, vadStartMs: 0, vadEndMs: 4600, sourceText: '你好', targetText: 'Hello', sourceLang: 'zh', emotion: 'neutral', audioPath: null, usageJson: null });
    const r = await (await get('/segments?sessionId=s1')).json() as { segments: Array<{ target_text: string }> };
    expect(r.segments[0]!.target_text).toBe('Hello');
  });

  it('GET /segment-audio streams the stored wav', async () => {
    gw.storage.createSession({ id: 's2', mode: 'solo', configJson: '{}', startedAt: 1000 });
    const p = gw.storage.saveSegmentAudio('s2', 1, new Uint8Array([1, 2, 3]));
    gw.storage.insertSegment({ sessionId: 's2', seq: 1, vadStartMs: null, vadEndMs: null, sourceText: 'a', targetText: 'b', sourceLang: null, emotion: null, audioPath: p, usageJson: null });
    const res = await get('/segment-audio?sessionId=s2&seq=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('GET /session-log returns raw jsonl text, 404 when missing', async () => {
    mkdirSync(join(dir, 'logs', 'sessions'), { recursive: true });
    writeFileSync(join(dir, 'logs', 'sessions', 's3.jsonl'), '{"ts":1,"dir":"s2c","type":"session.created","payload":{}}\n');
    const ok = await get('/session-log?sessionId=s3');
    expect(ok.status).toBe(200);
    expect((await ok.text()).trim()).toContain('session.created');
    expect((await get('/session-log?sessionId=nope')).status).toBe(404);
  });

  it('POST /sessions/delete removes session, segments and audio dir', async () => {
    gw.storage.createSession({ id: 's4', mode: 'solo', configJson: '{}', startedAt: 1000 });
    const p = gw.storage.saveSegmentAudio('s4', 1, new Uint8Array([9]));
    gw.storage.insertSegment({ sessionId: 's4', seq: 1, vadStartMs: null, vadEndMs: null, sourceText: 'a', targetText: 'b', sourceLang: null, emotion: null, audioPath: p, usageJson: null });
    const res = await fetch(`http://127.0.0.1:${gw.port}/sessions/delete`, { method: 'POST', body: JSON.stringify({ id: 's4' }) });
    expect(res.status).toBe(200);
    expect(gw.storage.getSession('s4')).toBeUndefined();
    expect(existsSync(join(dir, 'audio', 's4'))).toBe(false);
  });
});
