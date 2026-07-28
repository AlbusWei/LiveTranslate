import type { RawDirection, ServerEvent } from '../protocol/types';

// 体积控制（spec §6.6）：音频 base64 默认截断为长度+哈希
const AUDIO_FIELD_BY_TYPE: Record<string, string> = {
  'input_audio_buffer.append': 'audio',
  'response.audio.delta': 'delta',
  'input_image_buffer.append': 'image',
};
const SECRET_FIELDS = new Set(['authorization', 'apikey', 'api_key', 'bearer']);

export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export interface SessionLoggerOptions {
  sink: (line: string) => void; // 文件追加流在网关层注入（Task 8 FileSink）
  now?: () => number;
  fullAudio?: boolean; // 设置页“完整音频负载”开关
}

export class SessionLogger {
  private now: () => number;
  private fullAudio: boolean;

  constructor(private opts: SessionLoggerOptions) {
    this.now = opts.now ?? Date.now;
    this.fullAudio = opts.fullAudio ?? false;
  }

  record(dir: RawDirection, payload: ServerEvent): void {
    this.emit(dir, payload.type, payload);
  }

  // 合成生命周期事件（reconnect/downgrade/rotation）；payload 不含 type 字段
  lifecycle(action: string, detail: Record<string, unknown> = {}): void {
    this.emit('c2s', '_lifecycle', { action, ...detail });
  }

  private emit(dir: RawDirection, type: string, payload: Record<string, unknown>): void {
    this.opts.sink(JSON.stringify({
      ts: this.now(), dir, type, payload: this.sanitize(type, payload),
    }));
  }

  private sanitize(type: string, payload: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const audioField = this.fullAudio ? undefined : AUDIO_FIELD_BY_TYPE[type];
    for (const [k, v] of Object.entries(payload)) {
      if (SECRET_FIELDS.has(k.toLowerCase())) {
        out[k] = '<redacted>';
      } else if (k === audioField && typeof v === 'string') {
        out[k] = `<b64 len=${v.length} fnv1a=${fnv1a(v)}>`;
      } else {
        out[k] = v;
      }
    }
    return out;
  }
}
