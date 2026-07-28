import type { AppSettingsDto, GatewayApi, SelfCheckDto } from '../api';

export interface SettingsUiState {
  settings: AppSettingsDto;
  maskedKey: string;
  hasKey: boolean;
  selfCheck: SelfCheckDto | null;
  busy: boolean;
  lastError: string | null;
}

const INITIAL: AppSettingsDto = {
  workspaceHost: '', protocolPreference: 'auto', sourceLanguage: 'auto', targetLanguage: 'en',
  defaultVoice: 'Tina', hotwordTables: [], frameExtraction: { enabled: true, fps: 1 }, fullAudioLogs: false,
};

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class SettingsUiStore {
  state: SettingsUiState = { settings: INITIAL, maskedKey: '', hasKey: false, selfCheck: null, busy: false, lastError: null };
  private listeners = new Set<() => void>();
  // saveSettings 并发防乱序：只有最新一次请求的响应才允许写 state
  private saveVersion = 0;

  constructor(private api: GatewayApi) {}

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private set(patch: Partial<SettingsUiState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  async load(): Promise<void> {
    this.set({ busy: true, lastError: null });
    try {
      const r = await this.api.getSettings();
      this.set({ settings: r.settings, maskedKey: r.maskedKey, hasKey: r.hasKey });
    } catch (e) {
      this.set({ lastError: errMsg(e) });
    } finally {
      this.set({ busy: false });
    }
  }

  async saveSettings(patch: Partial<AppSettingsDto>): Promise<void> {
    const v = ++this.saveVersion;
    this.set({ busy: true, lastError: null });
    try {
      const r = await this.api.postSettings({ patch });
      if (v === this.saveVersion) this.set({ settings: r.settings });
    } catch (e) {
      if (v === this.saveVersion) this.set({ lastError: errMsg(e) });
    } finally {
      // 过期请求不碰 busy：更新一次的请求仍在途，由它负责复位
      if (v === this.saveVersion) this.set({ busy: false });
    }
  }

  async saveApiKey(apiKey: string): Promise<void> {
    this.set({ busy: true, lastError: null });
    try {
      const r = await this.api.postSettings({ apiKey });
      this.set({ maskedKey: r.maskedKey, hasKey: r.hasKey });
    } catch (e) {
      this.set({ lastError: errMsg(e) });
    } finally {
      this.set({ busy: false });
    }
  }

  async runSelfCheck(): Promise<void> {
    this.set({ busy: true, selfCheck: null, lastError: null });
    try {
      const result = await this.api.selfCheck();
      this.set({ selfCheck: result });
    } catch (e) {
      this.set({ lastError: errMsg(e) });
    } finally {
      this.set({ busy: false });
    }
  }
}
