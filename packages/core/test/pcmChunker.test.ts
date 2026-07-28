import { describe, it, expect } from 'vitest';
import { PcmChunker } from '../src/audio/pcmChunker';

describe('PcmChunker (P7: 3200 bytes = 100ms)', () => {
  it('buffers until 3200 bytes then emits fixed-size chunks', () => {
    const chunks: ArrayBuffer[] = [];
    const c = new PcmChunker((b) => chunks.push(b));
    c.push(new Int16Array(800)); // 1600B → 不发
    expect(chunks.length).toBe(0);
    c.push(new Int16Array(800)); // 累计 3200B → 发 1 块
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.byteLength).toBe(3200);
  });

  it('large input splits into multiple chunks with remainder buffered', () => {
    const chunks: ArrayBuffer[] = [];
    const c = new PcmChunker((b) => chunks.push(b));
    c.push(new Int16Array(4000)); // 8000B = 2×3200 + 1600 缓存
    expect(chunks.length).toBe(2);
    c.flush();
    expect(chunks.length).toBe(3);
    expect(chunks[2]!.byteLength).toBe(1600);
  });
});
