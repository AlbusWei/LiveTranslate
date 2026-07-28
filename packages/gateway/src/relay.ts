import { WebSocket, type WebSocketServer } from 'ws';
import { SessionLogger } from '@livetranslate/core';
import type { ServerEvent } from '@livetranslate/core';
import type { SettingsStore } from './settings';
import type { SessionLogFiles } from './logFiles';

const MODEL = 'qwen3.5-livetranslate-flash-realtime';

export interface RelayOptions {
  settings: SettingsStore;
  logFiles: SessionLogFiles;
  upstreamScheme?: 'ws' | 'wss'; // 测试用 ws，生产默认 wss
}

export function attachRealtimeRelay(wss: WebSocketServer, opts: RelayOptions): void {
  const scheme = opts.upstreamScheme ?? 'wss';
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
    const pendingC2s: ServerEvent[] = [];

    const ensureLogger = (sessionId: string): SessionLogger => {
      if (!logger) {
        logger = new SessionLogger({
          sink: opts.logFiles.sinkFor(sessionId),
          fullAudio: opts.settings.get().fullAudioLogs,
        });
        for (const ev of pendingC2s.splice(0)) logger.record('c2s', ev);
      }
      return logger;
    };

    upstream.on('message', (raw) => {
      const text = String(raw);
      const ev = JSON.parse(text) as ServerEvent;
      if (ev.type === 'session.created') {
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
      else pendingC2s.push(ev);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
      else upstream.once('open', () => upstream.send(text));
    });
    upstream.on('close', (code) => {
      logger?.lifecycle('upstream-closed', { code });
      client.close();
    });
    upstream.on('error', (err) => {
      logger?.lifecycle('upstream-error', { message: err.message });
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'error', error: { code: 'upstream_error', message: err.message } }));
      }
      client.close();
    });
    client.on('close', () => {
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
    });
  });
}
