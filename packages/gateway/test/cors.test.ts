import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGatewayServer, type GatewayHandle } from '../src/server';
import { SettingsStore, type KeyStore } from '../src/settings';

class MemKeyStore implements KeyStore {
  private key: string | null = null;
  getKey(): string | null { return this.key; }
  setKey(k: string): void { this.key = k; }
  clearKey(): void { this.key = null; }
}

let handle: GatewayHandle;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lt-cors-'));
  const settings = new SettingsStore(join(dir, 'settings.json'), new MemKeyStore());
  handle = await createGatewayServer({ settings, dataDir: dir, port: 0 });
});

afterEach(async () => { await handle.close(); });

// 现状比计划更严格：仅反射本机开发 origin（localhost/127.0.0.1 任意端口），非白名单不回 CORS 头
// （serverGuards.test.ts 已覆盖 evil origin 拒绝路径；此处覆盖 E2E/网页调试端依赖的放行路径）
describe('gateway CORS', () => {
  it('answers OPTIONS preflight with 204 and reflected allow headers for the web debug origin', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/settings`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://127.0.0.1:5173' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
    expect(res.headers.get('access-control-allow-headers')).toBe('Content-Type');
  });

  it('adds reflected allow-origin header on normal routes', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/settings`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });
});
