import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
