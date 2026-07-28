// 与 session.update 线协议字段一一对应（snake_case），spec §4.2。
export type Modality = 'text' | 'audio';
export type VoiceCloneFrequency = 'never' | 'once' | 'always';

export interface SessionConfig {
  modalities: Modality[];
  voice: string; // 预设音色（如 'Tina'）；复刻时必须为 'default'
  enable_voice_clone?: boolean;
  voice_clone_options?: { frequency: VoiceCloneFrequency };
  sample_rate: 16000;
  input_audio_format: 'pcm';
  input_audio_transcription: {
    model: 'qwen3-asr-flash-realtime';
    language?: string; // 缺省 = 自动检测
  };
  translation: {
    language: string;
    corpus?: { phrases: Array<{ source: string; target: string }> };
  };
}

// response.done.usage 真实结构（session 累积值，spec §2.4 / P6）
export interface Usage {
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  input_tokens_details: { text_tokens: number; audio_tokens: number };
  output_tokens_details: { text_tokens: number; audio_tokens?: number };
}

// 原始服务端事件：开放结构，具体字段在 normalize.ts 收敛
export interface ServerEvent {
  event_id?: string;
  type: string;
  [key: string]: unknown;
}

// 归一化内部事件（TranscriptModel/AudioSegmenter/UsageMeter 的唯一输入）
export type NormalizedEvent =
  | { kind: 'session-created'; sessionId: string }
  | { kind: 'session-updated' }
  | { kind: 'session-finished' }
  | { kind: 'speech-started'; itemId: string; audioStartMs: number }
  | { kind: 'speech-stopped'; itemId: string; audioEndMs: number }
  | { kind: 'asr-delta'; itemId: string; text: string; stash: string; language: string | null; emotion: string | null }
  | { kind: 'asr-completed'; itemId: string; transcript: string; language: string | null; emotion: string | null }
  | { kind: 'response-created'; responseId: string }
  | { kind: 'translation-delta'; responseId: string; text: string; stash: string }
  | { kind: 'translation-done'; responseId: string; text: string }
  | { kind: 'audio-delta'; responseId: string; base64: string }
  | { kind: 'response-done'; responseId: string; usage: Usage | null }
  | { kind: 'server-error'; code: string; message: string; raw: ServerEvent };

export type NormalizedKind = NormalizedEvent['kind'];

export type RawDirection = 'c2s' | 's2c';

// spec §4.1 ITranslateTransport
export interface ITranslateTransport {
  connect(cfg: SessionConfig): Promise<void>; // 建连 + session.update + 等待 session.updated
  updateSession(patch: Partial<SessionConfig>): Promise<void>;
  appendAudio(pcm16: ArrayBuffer): void; // WS: base64 append；WebRTC: 写入音轨
  appendImage(jpegBase64: string): void; // 统一走事件通道
  finish(): Promise<void>; // session.finish → 等 session.finished → close（10s 兜底）
  abort(): void; // 立即断开（重置用）
  on<K extends NormalizedKind>(kind: K, cb: (ev: Extract<NormalizedEvent, { kind: K }>) => void): () => void;
  onRaw(cb: (dir: RawDirection, payload: ServerEvent) => void): () => void; // SessionLogger tap
  readonly kind: 'ws' | 'webrtc';
  getRemoteAudio(): MediaStream | null; // webrtc 专用；ws 恒 null
}
