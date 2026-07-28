import { describe, expect, it } from 'vitest';
import { rmsLevel } from '../src/audio/rms';

describe('rmsLevel', () => {
  it('returns 0 for empty input', () => {
    expect(rmsLevel(new Float32Array(0))).toBe(0);
  });

  it('returns 0 for silence', () => {
    expect(rmsLevel(new Float32Array(1024))).toBe(0);
  });

  it('returns the constant for a DC signal', () => {
    expect(rmsLevel(new Float32Array(256).fill(0.5))).toBeCloseTo(0.5, 6);
  });

  it('returns ~0.707 for a full-scale sine wave', () => {
    const f32 = new Float32Array(2400); // 100 个完整周期（1kHz @24k，周期 24 采样）
    for (let i = 0; i < f32.length; i++) f32[i] = Math.sin((2 * Math.PI * i) / 24);
    expect(rmsLevel(f32)).toBeCloseTo(Math.SQRT1_2, 3);
  });
});
