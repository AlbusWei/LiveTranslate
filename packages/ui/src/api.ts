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

// ---- 历史落库（T18 写入侧）：路径/字段与网关 historyRoutes 一一对应 ----

export interface CreateSessionBody {
  id: string;
  mode: 'solo' | 'filedub' | 'interpreter' | 'meeting';
  configJson: string;
  startedAt: number;
}

export interface SegmentBody {
  sessionId: string;
  seq: number;
  vadStartMs: number | null;
  vadEndMs: number | null;
  sourceText: string;
  targetText: string;
  sourceLang: string | null;
  emotion: string | null;
  usageJson: string | null;
  wavBase64?: string;
}

async function postJson(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${getPlatform().gatewayHttpBase()}${path}`, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`gateway ${path} -> HTTP ${res.status}`);
}

export const createSessionRecord = (b: CreateSessionBody): Promise<void> => postJson('/sessions', b);
export const finishSessionRecord = (b: { id: string; endedAt: number; usageJson: string }): Promise<void> => postJson('/sessions/finish', b);
export const postSegmentRecord = (b: SegmentBody): Promise<void> => postJson('/segments', b);

// ---- 历史查询（T19 读取侧）：字段为 SQLite 行的 snake_case ----

export interface SessionDto {
  id: string;
  mode: 'solo' | 'filedub' | 'interpreter' | 'meeting';
  config_json: string;
  started_at: number;
  ended_at: number | null;
  usage_json: string | null;
}

export interface SegmentDto {
  id: number;
  session_id: string;
  seq: number;
  vad_start_ms: number | null;
  vad_end_ms: number | null;
  source_text: string;
  target_text: string;
  source_lang: string | null;
  emotion: string | null;
  audio_path: string | null;
  usage_json: string | null;
}

export async function fetchSessions(mode?: SessionDto['mode']): Promise<SessionDto[]> {
  const base = getPlatform().gatewayHttpBase();
  const res = await fetch(`${base}/sessions${mode ? `?mode=${mode}` : ''}`);
  if (!res.ok) throw new Error(`gateway /sessions -> HTTP ${res.status}`);
  return ((await res.json()) as { sessions: SessionDto[] }).sessions;
}

export async function fetchSegments(sessionId: string): Promise<SegmentDto[]> {
  const res = await fetch(`${getPlatform().gatewayHttpBase()}/segments?sessionId=${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error(`gateway /segments -> HTTP ${res.status}`);
  return ((await res.json()) as { segments: SegmentDto[] }).segments;
}

export async function fetchSegmentAudio(sessionId: string, seq: number): Promise<Uint8Array> {
  const res = await fetch(`${getPlatform().gatewayHttpBase()}/segment-audio?sessionId=${encodeURIComponent(sessionId)}&seq=${seq}`);
  if (!res.ok) throw new Error(`gateway /segment-audio -> HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function fetchSessionLog(sessionId: string): Promise<string | null> {
  const res = await fetch(`${getPlatform().gatewayHttpBase()}/session-log?sessionId=${encodeURIComponent(sessionId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`gateway /session-log -> HTTP ${res.status}`);
  return res.text();
}

export const deleteSessionRecord = (id: string): Promise<void> => postJson('/sessions/delete', { id });

// ---- WebRTC SDP 交换（T34）：网关代理上游，Key 不出网关 ----

export async function exchangeSdp(offerSdp: string): Promise<string> {
  const res = await fetch(`${getPlatform().gatewayHttpBase()}/webrtc/sdp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: offerSdp,
  });
  if (!res.ok) throw new Error(`sdp exchange failed: ${res.status}`); // reject → AutoTransport 降级
  return res.text();
}

// ---- 媒体预处理作业（T21 写入/查询侧，T23 工作台消费）：与网关 mediaJobs 路由一一对应 ----

export interface MediaJobDto {
  id: string;
  source_path: string;
  frame_config_json: string;
  artifacts_json: string | null;
  status: 'pending' | 'processing' | 'done' | 'failed';
  session_id: string | null;
  created_at: number;
}

export interface MediaJobStatusDto {
  job: MediaJobDto;
  progress: { doneMs: number; totalMs: number } | null;
}

export interface CreateMediaJobBody {
  fileName: string;
  dataBase64: string;
  isVideo: boolean;
  sourceLanguage?: string;
  targetLanguage: string;
  voiceClone: boolean;
  voice: string;
  framesEnabled: boolean;
}

export async function createMediaJob(b: CreateMediaJobBody): Promise<string> {
  const res = await fetch(`${getPlatform().gatewayHttpBase()}/media-jobs`, { method: 'POST', body: JSON.stringify(b) });
  if (!res.ok) throw new Error(`gateway /media-jobs -> HTTP ${res.status}`);
  return ((await res.json()) as { jobId: string }).jobId;
}

export async function fetchMediaJob(id: string): Promise<MediaJobStatusDto | null> {
  const res = await fetch(`${getPlatform().gatewayHttpBase()}/media-job?id=${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`gateway /media-job -> HTTP ${res.status}`);
  return (await res.json()) as MediaJobStatusDto;
}

export const mediaFileUrl = (id: string): string =>
  `${getPlatform().gatewayHttpBase()}/media-file?id=${encodeURIComponent(id)}`;

// T25 导出：浏览器直接下载（Content-Disposition attachment）
export const exportUrl = (kind: 'srt' | 'txt' | 'dub-wav', sessionId: string): string =>
  `${getPlatform().gatewayHttpBase()}/export/${kind}?sessionId=${encodeURIComponent(sessionId)}`;

// ---- 会议模式（T32/T33）：与网关 meetingRoutes 一一对应 ----

export interface MeetingTurnTextDto {
  speaker: string;
  source_text: string;
  target_text: string;
  source_lang: string | null;
}

export const createMeetingRecord = (b: { id: string; roster: string[]; targetLanguage: string; createdAt: number }): Promise<void> =>
  postJson('/meetings', b);

export const postMeetingTurn = (b: { meetingId: string; speaker: string; sessionId: string; seq: number }): Promise<void> =>
  postJson('/meeting-turns', b);

export async function fetchMeetingTurns(meetingId: string): Promise<MeetingTurnTextDto[]> {
  const res = await fetch(`${getPlatform().gatewayHttpBase()}/meeting-turns?meetingId=${encodeURIComponent(meetingId)}`);
  if (!res.ok) throw new Error(`gateway /meeting-turns -> HTTP ${res.status}`);
  return ((await res.json()) as { turns: MeetingTurnTextDto[] }).turns;
}
