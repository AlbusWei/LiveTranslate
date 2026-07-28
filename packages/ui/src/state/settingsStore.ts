import type { AppSettingsDto, GatewayApi, SelfCheckDto } from '../api';

export interface SettingsUiState {
  settings: AppSettingsDto;
  maskedKey: string;
  hasKey: boolean;
  selfCheck: SelfCheckDto | null;
  busy: boolean;
}

const INITIAL: AppSettingsDto = {
  workspaceHost: '', protocolPreference: 'auto', sourceLanguage: 'auto', targetLanguage: 'en',
  defaultVoice: 'Tina', hotwordTables: [], frameExtraction: { enabled: true, fps: 1 }, fullAudioLogs: false,
};

export class SettingsUiStore {
  state: SettingsUiState = { settings: INITIAL, maskedKey: '', hasKey: false, selfCheck: null, busy: false };
  private listeners = new Set<() => void>();

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
    const r = await this.api.getSettings();
    this.set({ settings: r.settings, maskedKey: r.maskedKey, hasKey: r.hasKey });
  }

  async saveSettings(patch: Partial<AppSettingsDto>): Promise<void> {
    this.set({ busy: true });
    const r = await this.api.postSettings({ patch });
    this.set({ settings: r.settings, busy: false });
  }

  async saveApiKey(apiKey: string): Promise<void> {
    this.set({ busy: true });
    const r = await this.api.postSettings({ apiKey });
    this.set({ maskedKey: r.maskedKey, hasKey: r.hasKey, busy: false });
  }

  async runSelfCheck(): Promise<void> {
    this.set({ busy: true, selfCheck: null });
    const result = await this.api.selfCheck();
    this.set({ selfCheck: result, busy: false });
  }
}
