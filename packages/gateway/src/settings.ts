import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface HotwordTable {
  name: string;
  phrases: Array<{ source: string; target: string }>;
}

// 非密设置（spec §6.3）；API Key 另走 KeyStore
export interface AppSettings {
  workspaceHost: string; // {ws-id}.cn-beijing.maas.aliyuncs.com
  protocolPreference: 'auto' | 'ws'; // 自动（优先 WebRTC）/ 强制 WS
  sourceLanguage: string | 'auto';
  targetLanguage: string;
  defaultVoice: string;
  hotwordTables: HotwordTable[];
  frameExtraction: { enabled: boolean; fps: 1 | 2 };
  fullAudioLogs: boolean; // §6.6 “完整音频负载”开关
}

export const DEFAULT_SETTINGS: AppSettings = {
  workspaceHost: '',
  protocolPreference: 'auto',
  sourceLanguage: 'auto',
  targetLanguage: 'en',
  defaultVoice: 'Tina',
  hotwordTables: [],
  frameExtraction: { enabled: true, fps: 1 },
  fullAudioLogs: false,
};

// Key 存储抽象：桌面 safeStorage（apps/desktop/src/keyStore.ts）；独立进程 EnvKeyStore
export interface KeyStore {
  getKey(): string | null;
  setKey(key: string): void;
  clearKey(): void;
}

export class EnvKeyStore implements KeyStore {
  // 网页调试端：Key 存于网关进程 .env.local（D4），进程内可覆写
  private override: string | null = null;
  getKey(): string | null {
    return this.override ?? process.env.DASHSCOPE_API_KEY ?? null;
  }
  setKey(key: string): void {
    this.override = key;
  }
  clearKey(): void {
    this.override = null;
  }
}

export class SettingsStore {
  private settings: AppSettings;

  constructor(private filePath: string, private keyStore: KeyStore) {
    this.settings = existsSync(filePath)
      ? { ...DEFAULT_SETTINGS, ...(JSON.parse(readFileSync(filePath, 'utf8')) as Partial<AppSettings>) }
      : { ...DEFAULT_SETTINGS };
  }

  get(): AppSettings {
    return this.settings;
  }

  update(patch: Partial<AppSettings>): AppSettings {
    this.settings = { ...this.settings, ...patch };
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2), 'utf8');
    return this.settings;
  }

  setApiKey(key: string): void {
    this.keyStore.setKey(key);
  }

  hasApiKey(): boolean {
    return this.keyStore.getKey() !== null;
  }

  getApiKey(): string | null {
    return this.keyStore.getKey();
  }

  getMaskedKey(): string {
    const k = this.keyStore.getKey();
    if (!k) return '';
    return `${k.slice(0, 4)}……${k.slice(-4)}`;
  }
}
