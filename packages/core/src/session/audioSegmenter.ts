import { base64ToBytes } from '../audio/base64';
import type { NormalizedEvent } from '../protocol/types';

// 按 responseId 拼接 audio-delta，response-done 时交付完整 24k PCM（P9）
export class AudioSegmenter {
  private buffers = new Map<string, Uint8Array[]>();

  constructor(private onSegment: (responseId: string, pcm24k: Uint8Array) => void) {}

  apply(ev: NormalizedEvent): void {
    if (ev.kind === 'audio-delta') {
      const list = this.buffers.get(ev.responseId) ?? [];
      list.push(base64ToBytes(ev.base64));
      this.buffers.set(ev.responseId, list);
    }
    if (ev.kind === 'response-done') {
      const list = this.buffers.get(ev.responseId);
      if (!list || list.length === 0) return;
      this.buffers.delete(ev.responseId);
      const total = list.reduce((n, b) => n + b.length, 0);
      const pcm = new Uint8Array(total);
      let off = 0;
      for (const b of list) {
        pcm.set(b, off);
        off += b.length;
      }
      this.onSegment(ev.responseId, pcm);
    }
  }

  reset(): void {
    this.buffers.clear();
  }
}
