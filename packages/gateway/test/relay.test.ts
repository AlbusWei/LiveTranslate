import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGatewayServer, type GatewayHandle } from '../src/server';
import { SettingsStore, type KeyStore } from '../src/settings';

class MemKeyStore implements KeyStore {
  private key: string | null = 'sk-test-key';
  getKey(): string | null { return this.key; }
  setKey(k: string): void { this.key = k; }
  clearKey(): void { this.key = null; }
}

let upstream: WebSocketServer;
let upstreamAuth: string | undefined;
let gateway: GatewayHandle;
let dataDir: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'lt-relay-'));
  upstream = new WebSocketServer({ port: 0 });
  upstream.on('connection', (sock, req) => {
    upstreamAuth = req.headers.authorization;
    sock.send(JSON.stringify({ type: 'session.created', session: { id: 'sess_relay_1' } }));
    sock.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string };
      if (msg.type === 'session.update') sock.send(JSON.stringify({ type: 'session.updated' }));
      if (msg.type === 'session.finish') sock.send(JSON.stringify({ type: 'session.finished' }));
    });
  });
  await new Promise<void>((r) => upstream.on('listening', r));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const settings = new SettingsStore(join(dataDir, 'settings.json'), new MemKeyStore());
  settings.update({ workspaceHost: `127.0.0.1:${upstreamPort}` });
  gateway = await createGatewayServer({ settings, dataDir, port: 0, upstreamScheme: 'ws' });
});

afterEach(async () => {
  await gateway.close();
  upstream.close();
});

function connectClient(): Promise<WebSocket> {
  const c = new WebSocket(`ws://127.0.0.1:${gateway.port}/realtime`);
  return new Promise((resolve, reject) => {
    c.on('open', () => resolve(c));
    c.on('error', reject);
  });
}

const nextMsg = (c: WebSocket): Promise<{ type: string }> =>
  new Promise((r) => c.once('message', (raw) => r(JSON.parse(String(raw)) as { type: string })));

describe('gateway /realtime relay', () => {
  it('injects Bearer from KeyStore and relays session.created to client (P1)', async () => {
    const c = await connectClient();
    const ev = await nextMsg(c);
    expect(ev.type).toBe('session.created');
    expect(upstreamAuth).toBe('Bearer sk-test-key');
    c.close();
  });

  it('relays client frames upstream and answers back (session.update round-trip)', async () => {
    const c = await connectClient();
    await nextMsg(c); // session.created
    c.send(JSON.stringify({ type: 'session.update', session: { modalities: ['text'] } }));
    const ev = await nextMsg(c);
    expect(ev.type).toBe('session.updated');
    c.close();
  });

  it('writes a JSONL session log keyed by upstream session id (spec 6.6)', async () => {
    const c = await connectClient();
    await nextMsg(c);
    c.send(JSON.stringify({ type: 'session.finish' }));
    await nextMsg(c); // session.finished
    c.close();
    await new Promise((r) => setTimeout(r, 100)); // 等追加流 flush
    const logDir = join(dataDir, 'logs', 'sessions');
    const files = readdirSync(logDir);
    expect(files).toContain('sess_relay_1.jsonl');
    const lines = readFileSync(join(logDir, 'sess_relay_1.jsonl'), 'utf8').trim().split('\n');
    const parsed = lines.map((l) => JSON.parse(l) as { dir: string; type: string });
    expect(parsed.some((e) => e.dir === 's2c' && e.type === 'session.created')).toBe(true);
    expect(parsed.some((e) => e.dir === 'c2s' && e.type === 'session.finish')).toBe(true);
    expect(readFileSync(join(logDir, 'sess_relay_1.jsonl'), 'utf8')).not.toContain('sk-test-key');
  });
});
