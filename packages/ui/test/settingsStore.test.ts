import { describe, it, expect } from 'vitest';
import { SettingsUiStore } from '../src/state/settingsStore';
import type { AppSettingsDto, GatewayApi } from '../src/api';

const BASE: AppSettingsDto = {
  workspaceHost: '', protocolPreference: 'auto', sourceLanguage: 'auto', targetLanguage: 'en',
  defaultVoice: 'Tina', hotwordTables: [], frameExtraction: { enabled: true, fps: 1 }, fullAudioLogs: false,
};

function fakeApi(overrides: Partial<GatewayApi> = {}): GatewayApi {
  return {
    getSettings: async () => ({ settings: BASE, maskedKey: '', hasKey: false }),
    postSettings: async (body) => ({
      settings: { ...BASE, ...(body.patch ?? {}) },
      maskedKey: body.apiKey ? 'sk-a……key1' : '',
      hasKey: Boolean(body.apiKey),
    }),
    selfCheck: async () => ({ ok: true, sessionId: 'sess_ui', latencyMs: 240 }),
    ...overrides,
  };
}

describe('SettingsUiStore', () => {
  it('load() pulls settings and key state from gateway', async () => {
    const s = new SettingsUiStore(fakeApi());
    await s.load();
    expect(s.state.settings.targetLanguage).toBe('en');
    expect(s.state.hasKey).toBe(false);
  });

  it('saveApiKey() posts key and updates masked display', async () => {
    const s = new SettingsUiStore(fakeApi());
    await s.load();
    await s.saveApiKey('sk-abcdefkey1');
    expect(s.state.maskedKey).toBe('sk-a……key1');
    expect(s.state.hasKey).toBe(true);
  });

  it('runSelfCheck() stores latency result; failure stores reason', async () => {
    const ok = new SettingsUiStore(fakeApi());
    await ok.runSelfCheck();
    expect(ok.state.selfCheck).toEqual({ ok: true, sessionId: 'sess_ui', latencyMs: 240 });
    const bad = new SettingsUiStore(fakeApi({ selfCheck: async () => ({ ok: false, reason: 'closed code=1008' }) }));
    await bad.runSelfCheck();
    expect(bad.state.selfCheck).toEqual({ ok: false, reason: 'closed code=1008' });
  });

  it('hotword table editing round-trips through postSettings', async () => {
    const s = new SettingsUiStore(fakeApi());
    await s.load();
    await s.saveSettings({ hotwordTables: [{ name: '会议', phrases: [{ source: '百炼', target: 'Model Studio' }] }] });
    expect(s.state.settings.hotwordTables[0]!.name).toBe('会议');
  });

  it('failed load/saveSettings resets busy and records lastError without touching settings', async () => {
    const s = new SettingsUiStore(fakeApi({
      getSettings: async () => { throw new Error('fetch failed: gateway down'); },
      postSettings: async () => { throw new Error('HTTP 500'); },
    }));
    await s.load();
    expect(s.state.busy).toBe(false);
    expect(s.state.lastError).toContain('gateway down');
    await s.saveSettings({ targetLanguage: 'ja' });
    expect(s.state.busy).toBe(false);
    expect(s.state.lastError).toContain('HTTP 500');
    expect(s.state.settings.targetLanguage).toBe('en'); // 失败不写入
  });

  it('saveApiKey/runSelfCheck throw: busy resets, lastError set, selfCheck stays null', async () => {
    const s = new SettingsUiStore(fakeApi({
      postSettings: async () => { throw new Error('ECONNREFUSED'); },
      selfCheck: async () => { throw new Error('gateway /self-check -> HTTP 502'); },
    }));
    await s.saveApiKey('sk-x');
    expect(s.state.busy).toBe(false);
    expect(s.state.lastError).toContain('ECONNREFUSED');
    await s.runSelfCheck();
    expect(s.state.busy).toBe(false);
    expect(s.state.lastError).toContain('502');
    expect(s.state.selfCheck).toBeNull();
  });

  it('stale saveSettings response does not overwrite a newer one', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => { releaseFirst = r; });
    let calls = 0;
    const s = new SettingsUiStore(fakeApi({
      postSettings: async (body) => {
        calls += 1;
        if (calls === 1) await firstGate; // 第一次请求晚于第二次返回
        return { settings: { ...BASE, ...(body.patch ?? {}) }, maskedKey: '', hasKey: false };
      },
    }));
    const p1 = s.saveSettings({ targetLanguage: 'ja' });
    const p2 = s.saveSettings({ targetLanguage: 'ko' });
    await p2;
    releaseFirst();
    await p1;
    expect(s.state.settings.targetLanguage).toBe('ko'); // 过期响应被丢弃
    expect(s.state.busy).toBe(false);
  });
});
