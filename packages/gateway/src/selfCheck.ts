import { WebSocket } from 'ws';

const MODEL = 'qwen3.5-livetranslate-flash-realtime';

export interface SelfCheckInput {
  host: string;
  apiKey: string;
  scheme?: 'ws' | 'wss';
  timeoutMs?: number;
}

export type SelfCheckResult =
  | { ok: true; sessionId: string; latencyMs: number }
  | { ok: false; reason: string };

export function runSelfCheck(input: SelfCheckInput): Promise<SelfCheckResult> {
  const scheme = input.scheme ?? 'wss';
  const timeoutMs = input.timeoutMs ?? 5000;
  const started = Date.now();
  return new Promise((resolve) => {
    const ws = new WebSocket(`${scheme}://${input.host}/api-ws/v1/realtime?model=${MODEL}`, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
    });
    let settled = false;
    const settle = (result: SelfCheckResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* 已断开 */ }
      resolve(result);
    };
    const timer = setTimeout(() => settle({ ok: false, reason: `timeout after ${timeoutMs}ms` }), timeoutMs);
    ws.on('message', (raw) => {
      const ev = JSON.parse(String(raw)) as { type: string; session?: { id?: string } };
      if (ev.type === 'session.created') {
        settle({ ok: true, sessionId: String(ev.session?.id ?? ''), latencyMs: Date.now() - started });
      }
    });
    ws.on('close', (code, reason) => settle({ ok: false, reason: `closed code=${code} ${String(reason)}` }));
    ws.on('error', (err) => settle({ ok: false, reason: err.message }));
  });
}
