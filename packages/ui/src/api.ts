import { getPlatform } from './platform';

export interface HotwordTableDto {
  name: string;
  phrases: Array<{ source: string; target: string }>;
}

// 与 packages/gateway/src/settings.ts 的 AppSettings 字段一一对应（网关是唯一真相源）
export interface AppSettingsDto {
  workspaceHost: string;
  protocolPreference: 'auto' | 'ws';
  sourceLanguage: string;
  targetLanguage: string;
  defaultVoice: string;
  hotwordTables: HotwordTableDto[];
  frameExtraction: { enabled: boolean; fps: 1 | 2 };
  fullAudioLogs: boolean;
}

export interface SettingsResponse {
  settings: AppSettingsDto;
  maskedKey: string;
  hasKey: boolean;
}

export type SelfCheckDto =
  | { ok: true; sessionId: string; latencyMs: number }
  | { ok: false; reason: string };

export interface GatewayApi {
  getSettings(): Promise<SettingsResponse>;
  postSettings(body: { patch?: Partial<AppSettingsDto>; apiKey?: string }): Promise<SettingsResponse>;
  selfCheck(): Promise<SelfCheckDto>;
}

export function createGatewayApi(): GatewayApi {
  const base = getPlatform().gatewayHttpBase();
  const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${base}${path}`, init);
    if (!res.ok) throw new Error(`gateway ${path} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  return {
    getSettings: () => json<SettingsResponse>('/settings'),
    postSettings: (body) => json<SettingsResponse>('/settings', { method: 'POST', body: JSON.stringify(body) }),
    selfCheck: () => json<SelfCheckDto>('/self-check', { method: 'POST', body: '{}' }),
  };
}
