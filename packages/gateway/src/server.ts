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
  maxPending?: number; // 透传 relay，测试用
  handshakeTimeoutMs?: number; // 透传 relay，测试用
}

export interface GatewayHandle {
  port: number;
  server: Server;
  close(): Promise<void>;
}

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, body: string) => Promise<void> | void;

const MAX_BODY_BYTES = 1_000_000; // 1MB：设置/术语表足够，防恶意大包体

// 网页调试端（vite :5173）跨源访问本地网关：仅对本机开发 origin 放行
function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (!origin || !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export async function createGatewayServer(opts: GatewayOptions): Promise<GatewayHandle> {
  // 实例私有路由表：多 gateway 实例互不干扰（后续任务 T18/T19/T25/T32/T34 在此注册）
  const routes = new Map<string, RouteHandler>();
  const logFiles = new SessionLogFiles(opts.dataDir);
  const server = createServer((req, res) => {
    let body = '';
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      if (tooLarge) return;
      body += c.toString();
      if (body.length > MAX_BODY_BYTES) {
        tooLarge = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload_too_large' }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      const cors = corsHeaders(req);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      const handler = routes.get(`${req.method} ${(req.url ?? '').split('?')[0]}`);
      if (!handler) {
        res.writeHead(404, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      // 先于 handler 注入 CORS 头：writeHead 时与各路由自身头合并
      for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
      void handler(req, res, body);
    });
  });
  const wss = new WebSocketServer({ server, path: '/realtime' });
  attachRealtimeRelay(wss, {
    settings: opts.settings,
    logFiles,
    upstreamScheme: opts.upstreamScheme,
    maxPending: opts.maxPending,
    handshakeTimeoutMs: opts.handshakeTimeoutMs,
  });
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
