import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore, DEFAULT_SETTINGS, type KeyStore } from '../src/settings';

class MemKeyStore implements KeyStore {
  private key: string | null = null;
  getKey(): string | null { return this.key; }
  setKey(k: string): void { this.key = k; }
  clearKey(): void { this.key = null; }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-settings-'));
});

describe('SettingsStore', () => {
  it('returns defaults when file is missing', () => {
    const s = new SettingsStore(join(dir, 'settings.json'), new MemKeyStore());
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('persists non-secret settings as JSON and reloads them', () => {
    const file = join(dir, 'settings.json');
    const s = new SettingsStore(file, new MemKeyStore());
    s.update({ workspaceHost: 'ws-abc.cn-beijing.maas.aliyuncs.com', targetLanguage: 'ja' });
    const reloaded = new SettingsStore(file, new MemKeyStore());
    expect(reloaded.get().workspaceHost).toBe('ws-abc.cn-beijing.maas.aliyuncs.com');
    expect(reloaded.get().targetLanguage).toBe('ja');
    // API Key 永不落入 settings.json（D4）
    expect(readFileSync(file, 'utf8')).not.toContain('sk-');
  });

  it('API key goes through KeyStore only; getMaskedKey() redacts middle', () => {
    const ks = new MemKeyStore();
    const s = new SettingsStore(join(dir, 'settings.json'), ks);
    s.setApiKey('sk-abcdef1234567890');
    expect(ks.getKey()).toBe('sk-abcdef1234567890');
    expect(s.getMaskedKey()).toBe('sk-a……7890');
    expect(s.hasApiKey()).toBe(true);
  });

  it('hot-word tables: named lists survive reload', () => {
    const file = join(dir, 'settings.json');
    const s = new SettingsStore(file, new MemKeyStore());
    s.update({
      hotwordTables: [{ name: '医疗', phrases: [{ source: '造影剂', target: 'contrast agent' }] }],
    });
    const reloaded = new SettingsStore(file, new MemKeyStore());
    expect(reloaded.get().hotwordTables[0]!.phrases[0]!.target).toBe('contrast agent');
  });

  it('corrupted settings.json falls back to defaults and keeps a .corrupt copy', () => {
    const file = join(dir, 'settings.json');
    writeFileSync(file, '{ not valid json', 'utf8');
    const s = new SettingsStore(file, new MemKeyStore());
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
    const corruptCopies = readdirSync(dir).filter((f) => f.startsWith('settings.json.corrupt-'));
    expect(corruptCopies.length).toBe(1);
    expect(readFileSync(join(dir, corruptCopies[0]!), 'utf8')).toBe('{ not valid json');
  });
});
