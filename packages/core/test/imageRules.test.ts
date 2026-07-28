import { describe, expect, it } from 'vitest';
import { MAX_FRAME_BYTES, MAX_FRAME_FPS, filterOversizedFrames, rawBytesOfBase64 } from '../src/file/imageRules';
import type { PipelineFrame } from '../src/file/filePipeline';

describe('imageRules (P11)', () => {
  it('computes raw byte size from base64 length and padding', () => {
    expect(rawBytesOfBase64('QUJD')).toBe(3); // "ABC"
    expect(rawBytesOfBase64('QUI=')).toBe(2);
    expect(rawBytesOfBase64('QQ==')).toBe(1);
    expect(rawBytesOfBase64('')).toBe(0);
  });

  it('exposes protocol constants', () => {
    expect(MAX_FRAME_BYTES).toBe(190 * 1024); // base64 编码前 ≤190KB
    expect(MAX_FRAME_FPS).toBe(2);
  });

  it('drops frames above 190KB and keeps the rest in order', () => {
    const small: PipelineFrame = { timeMs: 0, jpegBase64: 'QUJD' };
    // 259416 个 base64 字符（无 padding）= 194562 原始字节 > 194560
    const big: PipelineFrame = { timeMs: 500, jpegBase64: 'A'.repeat(259416) };
    const tail: PipelineFrame = { timeMs: 1000, jpegBase64: 'QQ==' };
    const { kept, droppedTimesMs } = filterOversizedFrames([small, big, tail]);
    expect(kept).toEqual([small, tail]);
    expect(droppedTimesMs).toEqual([500]);
  });
});
