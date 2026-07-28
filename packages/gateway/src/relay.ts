import { WebSocket, type WebSocketServer } from 'ws';
import { SessionLogger } from '@livetranslate/core';
import type { ServerEvent } from '@livetranslate/core';
import type { SettingsStore } from './settings';
import type { SessionLogFiles } from './logFiles';

const MODEL = 'qwen3.5-livetranslate-flash-realtime';
const MAX_PENDING = 1000; // 缓冲上限：防上游迟迟不就绪时内存无界增长
const HANDSHAKE_TIMEOUT_MS = 10_000; // 上游限时未回 session.created 视为握手失败

export interface RelayOptions {
  settings: SettingsStore;
  logFiles: SessionLogFiles;
  upstreamScheme?: 'ws' | 'wss'; // 测试用 ws，生产默认 wss
  maxPending?: number; // 测试可调小
  handshakeTimeoutMs?: number; // 测试可调小
}

export function attachRealtimeRelay(wss: WebSocketServer, opts: RelayOptions): void {
  const scheme = opts.upstreamScheme ?? 'wss';
  const maxPending = opts.maxPending ?? MAX_PENDING;
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  wss.on('connection', (client) => {
    const key = opts.settings.getApiKey();
    const host = opts.settings.get().workspaceHost;
    if (!key || !host) {
      client.send(JSON.stringify({ type: 'error', error: { code: 'gateway_not_configured', message: 'API Key 或 Workspace Host 未配置，请到设置页填写' } }));
      client.close();
      return;
    }
    const upstream = new WebSocket(`${scheme}://${host}/api-ws/v1/realtime?model=${MODEL}`, {
      headers: { Authorization: `Bearer ${key}` }, // P1：Key 只在网关侧出现
    });
    let logger: SessionLogger | null = null;
    const pendingC2s: ServerEvent[] = []; // logger 建立前的日志缓冲（有上限）
    const outbox: string[] = []; // upstream 未 open 前的发送队列（有上限，open 后统一 flush）
    let droppedLog = 0;
    let droppedSend = 0;

    const ensureLogger = (sessionId: string): SessionLogger => {
      if (!logger) {
        logger = new SessionLogger({
          sink: opts.logFiles.sinkFor(sessionId),
          fullAudio: opts.settings.get().fullAudioLogs,
        });
        for (const ev of pendingC2s.splice(0)) logger.record('c2s', ev);
        if (droppedLog > 0) logger.lifecycle('pending-log-dropped', { count: droppedLog });
        if (droppedSend > 0) logger.lifecycle('outbox-dropped', { count: droppedSend });
      }
      return logger;
    };

    // 握手超时：限时内未收到 session.created 则关闭双端并清空缓冲
    const handshakeTimer = setTimeout(() => {
      ensureLogger(`sess_local_${Date.now()}`).lifecycle('upstream-handshake-timeout', { timeoutMs: handshakeTimeoutMs });
      pendingC2s.length = 0;
      outbox.length = 0;
      try { upstream.close(); } catch { /* 已断开 */ }
      client.close();
    }, handshakeTimeoutMs);

    upstream.on('open', () => {
      for (const text of outbox.splice(0)) upstream.send(text);
    });
    upstream.on('message', (raw) => {
      const text = String(raw);
      const ev = JSON.parse(text) as ServerEvent;
      if (ev.type === 'session.created') {
        clearTimeout(handshakeTimer);
        const sessionId = String((ev.session as { id?: string } | undefined)?.id ?? `sess_local_${Date.now()}`);
        ensureLogger(sessionId);
      }
      logger?.record('s2c', ev);
      if (client.readyState === WebSocket.OPEN) client.send(text);
    });
    client.on('message', (raw) => {
      const text = String(raw);
      const ev = JSON.parse(text) as ServerEvent;
      if (logger) logger.record('c2s', ev);
      else if (pendingC2s.length < maxPending) pendingC2s.push(ev);
      else droppedLog++; // 超限丢弃，logger 建立时补记 _lifecycle
      if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
      else if (upstream.readyState === WebSocket.CONNECTING) {
        if (outbox.length < maxPending) outbox.push(text);
        else droppedSend++;
      } // CLOSING/CLOSED：直接丢弃
    });
    upstream.on('close', (code) => {
      clearTimeout(handshakeTimer);
      logger?.lifecycle('upstream-closed', { code });
      client.close();
    });
    upstream.on('error', (err) => {
      clearTimeout(handshakeTimer);
      logger?.lifecycle('upstream-error', { message: err.message });
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'error', error: { code: 'upstream_error', message: err.message } }));
      }
      client.close();
    });
    client.on('close', () => {
      clearTimeout(handshakeTimer);
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
    });
  });
}
