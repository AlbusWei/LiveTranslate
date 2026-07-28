import { describe, it, expect } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { request as httpRequest } from 'node:http';
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

interface Rig {
  upstream: WebSocketServer;
  gateway: GatewayHandle;
  dataDir: string;
  close(): Promise<void>;
}

async function startRig(
  onConnection: (sock: WebSocket) => void,
  gwOpts: { maxPending?: number; handshakeTimeoutMs?: number } = {},
): Promise<Rig> {
  const dataDir = mkdtempSync(join(tmpdir(), 'lt-guard-'));
  const upstream = new WebSocketServer({ port: 0 });
  upstream.on('connection', onConnection);
  await new Promise<void>((r) => upstream.on('listening', r));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const settings = new SettingsStore(join(dataDir, 'settings.json'), new MemKeyStore());
  settings.update({ workspaceHost: `127.0.0.1:${upstreamPort}` });
  const gateway = await createGatewayServer({ settings, dataDir, port: 0, upstreamScheme: 'ws', ...gwOpts });
  return {
    upstream, gateway, dataDir,
    close: async () => { await gateway.close(); upstream.close(); },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function readSessionLogs(dataDir: string): Array<{ file: string; lines: Array<{ dir: string; type: string; payload: Record<string, unknown> }> }> {
  const dir = join(dataDir, 'logs', 'sessions');
  return readdirSync(dir).map((file) => ({
    file,
    lines: readFileSync(join(dir, file), 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l) as { dir: string; type: string; payload: Record<string, unknown> }),
  }));
}

describe('relay buffer guards', () => {
  it('closes both ends and logs _lifecycle when upstream never sends session.created', async () => {
    const rig = await startRig(() => { /* 上游静默：不回 session.created */ }, { handshakeTimeoutMs: 200 });
    const c = new WebSocket(`ws://127.0.0.1:${rig.gateway.port}/realtime`);
    const closed = new Promise<void>((r) => c.on('close', () => r()));
    await new Promise<void>((r) => c.on('open', () => r()));
    await closed; // 200ms 超时后网关应主动关闭客户端
    await sleep(100);
    await rig.close();
    const logs = readSessionLogs(rig.dataDir);
    expect(logs.length).toBe(1);
    expect(logs[0]!.file).toMatch(/^sess_local_\d+\.jsonl$/);
    const timeoutLine = logs[0]!.lines.find((l) => l.type === '_lifecycle' && l.payload.action === 'upstream-handshake-timeout');
    expect(timeoutLine?.payload.timeoutMs).toBe(200);
  });

  it('caps pre-logger buffer at maxPending and records dropped count', async () => {
    const rig = await startRig((sock) => {
      // 收到 'go' 才回 session.created，之前客户端消息全部积压在 pendingC2s
      sock.on('message', (raw) => {
        if ((JSON.parse(String(raw)) as { type: string }).type === 'go') {
          sock.send(JSON.stringify({ type: 'session.created', session: { id: 'sess_cap' } }));
        }
      });
    }, { maxPending: 2 });
    const c = new WebSocket(`ws://127.0.0.1:${rig.gateway.port}/realtime`);
    await new Promise<void>((r) => c.on('open', () => r()));
    await sleep(300); // 等 upstream open，确保消息直发而非走 outbox
    for (const t of ['m1', 'm2', 'm3', 'm4', 'go']) c.send(JSON.stringify({ type: t }));
    await new Promise<void>((r) => c.on('message', (raw) => {
      if ((JSON.parse(String(raw)) as { type: string }).type === 'session.created') r();
    }));
    c.close();
    await sleep(100);
    await rig.close();
    const logs = readSessionLogs(rig.dataDir);
    const lines = logs.find((l) => l.file === 'sess_cap.jsonl')!.lines;
    expect(lines.some((l) => l.dir === 'c2s' && l.type === 'm1')).toBe(true);
    expect(lines.some((l) => l.dir === 'c2s' && l.type === 'm2')).toBe(true);
    expect(lines.some((l) => l.type === 'm3')).toBe(false); // 超限被丢弃
    const dropped = lines.find((l) => l.type === '_lifecycle' && l.payload.action === 'pending-log-dropped');
    expect(dropped?.payload.count).toBe(3); // m3、m4、go
  });

  it('flushes messages sent before upstream open (outbox, no per-message listeners)', async () => {
    const rig = await startRig((sock) => {
      sock.send(JSON.stringify({ type: 'session.created', session: { id: 'sess_flush' } }));
      sock.on('message', (raw) => {
        if ((JSON.parse(String(raw)) as { type: string }).type === 'session.update') {
          sock.send(JSON.stringify({ type: 'session.updated' }));
        }
      });
    });
    const c = new WebSocket(`ws://127.0.0.1:${rig.gateway.port}/realtime`);
    const got: string[] = [];
    const updated = new Promise<void>((r) => c.on('message', (raw) => {
      got.push((JSON.parse(String(raw)) as { type: string }).type);
      if (got.includes('session.updated')) r();
    }));
    // client open 时 upstream 多半仍在 CONNECTING：立即发送以覆盖 outbox 路径
    await new Promise<void>((r) => c.on('open', () => r()));
    c.send(JSON.stringify({ type: 'session.update', session: {} }));
    await updated;
    expect(got).toContain('session.created');
    c.close();
    await rig.close();
  });
});

describe('per-instance routes', () => {
  it('two gateways serve their own settings; closing one leaves the other intact', async () => {
    const mk = async (lang: string): Promise<{ gw: GatewayHandle; dataDir: string }> => {
      const dataDir = mkdtempSync(join(tmpdir(), 'lt-multi-'));
      const settings = new SettingsStore(join(dataDir, 'settings.json'), new MemKeyStore());
      settings.update({ targetLanguage: lang });
      return { gw: await createGatewayServer({ settings, dataDir, port: 0, upstreamScheme: 'ws' }), dataDir };
    };
    const a = await mk('ja');
    const b = await mk('ko');
    const getLang = async (port: number): Promise<string> => {
      const res = await fetch(`http://127.0.0.1:${port}/settings`);
      return ((await res.json()) as { settings: { targetLanguage: string } }).settings.targetLanguage;
    };
    expect(await getLang(a.gw.port)).toBe('ja');
    expect(await getLang(b.gw.port)).toBe('ko');
    await a.gw.close();
    expect(await getLang(b.gw.port)).toBe('ko'); // a 关闭不影响 b 的路由
    await b.gw.close();
  });
});

describe('CORS for local web debug UI', () => {
  it('reflects localhost dev origin and answers preflight; foreign origins get nothing', async () => {
    const rig = await startRig(() => { /* 上游不参与 */ });
    const base = `http://127.0.0.1:${rig.gateway.port}`;
    const ok = await fetch(`${base}/settings`, { headers: { Origin: 'http://localhost:5173' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const pre = await fetch(`${base}/settings`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-methods')).toContain('POST');
    const evil = await fetch(`${base}/settings`, { headers: { Origin: 'https://evil.example.com' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    await rig.close();
  });
});

describe('HTTP body size limit', () => {
  it('rejects >1MB bodies with 413 and leaves settings untouched', async () => {
    const rig = await startRig(() => { /* 上游不参与 */ });
    const big = JSON.stringify({ patch: { targetLanguage: 'xx', junk: 'a'.repeat(1_100_000) } });
    const result = await new Promise<{ status?: number; error?: string }>((resolve) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: rig.gateway.port, method: 'POST', path: '/settings' },
        (res) => resolve({ status: res.statusCode }),
      );
      req.on('error', (e) => resolve({ error: e.message })); // req.destroy() 可能先掐断连接
      req.end(big);
    });
    if (result.status !== undefined) expect(result.status).toBe(413);
    else expect(result.error).toBeTruthy();
    // 无论响应是否送达，超限请求绝不能改动设置
    const res = await fetch(`http://127.0.0.1:${rig.gateway.port}/settings`);
    const settings = ((await res.json()) as { settings: { targetLanguage: string } }).settings;
    expect(settings.targetLanguage).toBe('en');
    await rig.close();
  });
});
