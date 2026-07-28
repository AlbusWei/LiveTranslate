import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import { runSelfCheck } from '../src/selfCheck';

let upstream: WebSocketServer | null = null;

afterEach(() => {
  upstream?.close();
  upstream = null;
});

async function startUpstream(behavior: 'ok' | 'silent' | 'reject'): Promise<number> {
  upstream = new WebSocketServer({ port: 0 });
  upstream.on('connection', (sock) => {
    if (behavior === 'ok') sock.send(JSON.stringify({ type: 'session.created', session: { id: 'sess_check' } }));
    if (behavior === 'reject') sock.close(1008, 'unauthorized');
  });
  await new Promise<void>((r) => upstream!.on('listening', r));
  return (upstream.address() as { port: number }).port;
}

describe('runSelfCheck', () => {
  it('ok: resolves with session id and round-trip latency', async () => {
    const port = await startUpstream('ok');
    const result = await runSelfCheck({ host: `127.0.0.1:${port}`, apiKey: 'sk-x', scheme: 'ws', timeoutMs: 2000 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.sessionId).toBe('sess_check');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('rejected connection: returns ok=false with reason', async () => {
    const port = await startUpstream('reject');
    const result = await runSelfCheck({ host: `127.0.0.1:${port}`, apiKey: 'sk-x', scheme: 'ws', timeoutMs: 2000 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('closed');
  });

  it('silent upstream: times out with ok=false', async () => {
    const port = await startUpstream('silent');
    const result = await runSelfCheck({ host: `127.0.0.1:${port}`, apiKey: 'sk-x', scheme: 'ws', timeoutMs: 300 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('timeout after 300ms');
  });
});
