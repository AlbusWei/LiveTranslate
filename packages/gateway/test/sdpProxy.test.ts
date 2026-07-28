import { mkdtempSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerSdpProxy } from '../src/sdpProxy';
import type { RouteHandler } from '../src/server';
import { SettingsStore, type KeyStore } from '../src/settings';

class MemKeyStore implements KeyStore {
  private key: string | null = null;
  getKey(): string | null { return this.key; }
  setKey(k: string): void { this.key = k; }
  clearKey(): void { this.key = null; }
}

function fakeRes() {
  const chunks: string[] = [];
  let statusCode = 0;
  const res = {
    writeHead: (code: number) => { statusCode = code; return res; },
    end: (data?: string) => { if (data !== undefined) chunks.push(data); },
  } as unknown as ServerResponse;
  return {
    res,
    text: () => chunks.join(''),
    json: () => JSON.parse(chunks.join('')) as Record<string, unknown>,
    status: () => statusCode,
  };
}

const OFFER_SDP = 'v=0\r\no=- 46117317 2 IN IP4 127.0.0.1\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n';

let settings: SettingsStore;
let routes: Map<string, RouteHandler>;
let calls: Array<{ url: string; init: RequestInit }>;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'lt-sdp-'));
  settings = new SettingsStore(join(dir, 'settings.json'), new MemKeyStore());
  routes = new Map();
  calls = [];
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response('v=0\r\no=answer\r\n', { status: 200, headers: { 'Content-Type': 'application/sdp' } });
  }) as typeof fetch;
  registerSdpProxy(routes, { settings, fetchImpl: fakeFetch });
});

describe('sdp proxy', () => {
  it('forwards the offer to the bailian webrtc endpoint with bearer auth', async () => {
    settings.update({ workspaceHost: 'dashscope.aliyuncs.com' });
    settings.setApiKey('sk-test-123');
    const r = fakeRes();
    await routes.get('POST /webrtc/sdp')!({ url: '/webrtc/sdp' } as never, r.res, OFFER_SDP);

    expect(calls[0]!.url).toBe('https://dashscope.aliyuncs.com/api/v1/webrtc/realtime?model=qwen3.5-livetranslate-flash-realtime');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/sdp');
    expect(headers.Authorization).toBe('Bearer sk-test-123');
    expect(calls[0]!.init.body).toBe(OFFER_SDP); // offer 原文透传
    expect(r.status()).toBe(200);
    expect(r.text()).toBe('v=0\r\no=answer\r\n'); // answer 原文回传
  });

  it('rejects with 400 when key or host is missing', async () => {
    const r = fakeRes();
    await routes.get('POST /webrtc/sdp')!({ url: '/webrtc/sdp' } as never, r.res, OFFER_SDP);
    expect(r.status()).toBe(400);
    expect(r.json()).toEqual({ error: 'missing_key_or_host' });
    expect(calls).toHaveLength(0); // 未配 Key 绝不外呼
  });
});
