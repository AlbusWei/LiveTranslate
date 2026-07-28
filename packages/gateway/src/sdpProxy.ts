import type { ServerResponse } from 'node:http';
import type { RouteHandler } from './server';
import type { SettingsStore } from './settings';

const MODEL = 'qwen3.5-livetranslate-flash-realtime';

export interface SdpProxyDeps {
  settings: SettingsStore;
  fetchImpl?: typeof fetch; // 测试注入；生产用全局 fetch（Node 20+）
}

const json = (res: ServerResponse, code: number, payload: unknown): void => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
};

export function registerSdpProxy(routes: Map<string, RouteHandler>, deps: SdpProxyDeps): void {
  const doFetch = deps.fetchImpl ?? fetch;
  routes.set('POST /webrtc/sdp', async (_req, res, body) => {
    const key = deps.settings.getApiKey();
    const host = deps.settings.get().workspaceHost;
    if (!key || !host) {
      json(res, 400, { error: 'missing_key_or_host' });
      return;
    }
    // spec §2.5：SDP 交换端点；Bearer 只出现在网关侧，浏览器拿不到 Key
    const upstream = await doFetch(`https://${host}/api/v1/webrtc/realtime?model=${MODEL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp', Authorization: `Bearer ${key}` },
      body,
    });
    const answer = await upstream.text();
    res.writeHead(upstream.status, { 'Content-Type': 'application/sdp' });
    res.end(answer); // 白名单未开通等上游错误原样透传，交给 AutoTransport 触发降级
  });
}
