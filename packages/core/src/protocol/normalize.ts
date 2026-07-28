import type { NormalizedEvent, ServerEvent, Usage } from './types';

type Rec = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

// 原始服务端事件 → 归一化事件；与业务无关的事件（content_part/audio.done/rate_limits 等）返回 null。
// 事件名与字段全部来自真实冒烟日志（P4/P5/P6/P9）。
export function normalizeServerEvent(ev: ServerEvent): NormalizedEvent | null {
  switch (ev.type) {
    case 'session.created':
      return { kind: 'session-created', sessionId: str((ev.session as Rec | undefined)?.id) };
    case 'session.updated':
      return { kind: 'session-updated' };
    case 'session.finished':
      return { kind: 'session-finished' };
    case 'input_audio_buffer.speech_started':
      return { kind: 'speech-started', itemId: str(ev.item_id), audioStartMs: num(ev.audio_start_ms) };
    case 'input_audio_buffer.speech_stopped':
      return { kind: 'speech-stopped', itemId: str(ev.item_id), audioEndMs: num(ev.audio_end_ms) };
    case 'conversation.item.input_audio_transcription.text':
      return {
        kind: 'asr-delta', itemId: str(ev.item_id), text: str(ev.text), stash: str(ev.stash),
        language: strOrNull(ev.language), emotion: strOrNull(ev.emotion),
      };
    case 'conversation.item.input_audio_transcription.completed':
      return {
        kind: 'asr-completed', itemId: str(ev.item_id), transcript: str(ev.transcript),
        language: strOrNull(ev.language), emotion: strOrNull(ev.emotion),
      };
    case 'response.created':
      return { kind: 'response-created', responseId: str((ev.response as Rec | undefined)?.id) };
    case 'response.text.text':
    case 'response.audio_transcript.text':
      return { kind: 'translation-delta', responseId: str(ev.response_id), text: str(ev.text), stash: str(ev.stash) };
    case 'response.text.done':
      return { kind: 'translation-done', responseId: str(ev.response_id), text: str(ev.text) };
    case 'response.audio_transcript.done':
      return { kind: 'translation-done', responseId: str(ev.response_id), text: str(ev.transcript) };
    case 'response.audio.delta':
      return { kind: 'audio-delta', responseId: str(ev.response_id), base64: str(ev.delta) };
    case 'response.done': {
      const resp = ev.response as Rec | undefined;
      return { kind: 'response-done', responseId: str(resp?.id), usage: (resp?.usage as Usage | undefined) ?? null };
    }
    case 'error': {
      const err = (ev.error as Rec | undefined) ?? ev;
      return { kind: 'server-error', code: str(err.code ?? err.type), message: str(err.message), raw: ev };
    }
    default:
      return null;
  }
}
