import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import { attachRealtimeRelay } from './relay';
import { runSelfCheck } from './selfCheck';
import { SessionLogFiles } from './logFiles';
import type { SettingsStore } from './settings';

export interface GatewayOptions {
  settings: SettingsStore;
  dataDir: string;
  port: number; // 0 = 随机端口
  upstreamScheme?: 'ws' | 'wss';
}

export interface GatewayHandle {
  port: number;
  server: Server;
  close(): Promise<void>;
}

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, body: string) => Promise<void> | void;

// 后续任务（T9/T18/T19/T25/T32/T34）向这张表注册 REST 路由
export const routes = new Map<string, RouteHandler>();

export async function createGatewayServer(opts: GatewayOptions): Promise<GatewayHandle> {
  const logFiles = new SessionLogFiles(opts.dataDir);
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      const handler = routes.get(`${req.method} ${(req.url ?? '').split('?')[0]}`);
      if (!handler) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      void handler(req, res, body);
    });
  });
  const wss = new WebSocketServer({ server, path: '/realtime' });
  attachRealtimeRelay(wss, { settings: opts.settings, logFiles, upstreamScheme: opts.upstreamScheme });
  routes.set('GET /settings', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ settings: opts.settings.get(), maskedKey: opts.settings.getMaskedKey(), hasKey: opts.settings.hasApiKey() }));
  });
  routes.set('POST /settings', (_req, res, body) => {
    const parsed = JSON.parse(body) as { patch?: Record<string, unknown>; apiKey?: string };
    if (parsed.apiKey) opts.settings.setApiKey(parsed.apiKey);
    const settings = parsed.patch ? opts.settings.update(parsed.patch) : opts.settings.get();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ settings, maskedKey: opts.settings.getMaskedKey(), hasKey: opts.settings.hasApiKey() }));
  });
  routes.set('POST /self-check', async (_req, res) => {
    const key = opts.settings.getApiKey();
    const host = opts.settings.get().workspaceHost;
    const result = key && host
      ? await runSelfCheck({ host, apiKey: key })
      : { ok: false as const, reason: 'API Key 或 Workspace Host 未配置' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  });
  await new Promise<void>((r) => server.listen(opts.port, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    server,
    close: async () => {
      await logFiles.closeAll();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
