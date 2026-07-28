import { describe, it, expect } from 'vitest';
import { downsampleTo16kPcm16 } from '../src/audio/resample';

describe('downsampleTo16kPcm16', () => {
  it('48k -> 16k keeps 1/3 of samples', () => {
    const input = new Float32Array(4800).fill(0.5);
    const out = downsampleTo16kPcm16(input, 48000);
    expect(out.length).toBe(1600);
    expect(out[0]).toBe(Math.round(0.5 * 32767));
  });

  it('clamps out-of-range floats to int16 bounds', () => {
    const out = downsampleTo16kPcm16(new Float32Array([1.5, -1.5, 0]), 16000);
    expect(Array.from(out)).toEqual([32767, -32768, 0]);
  });

  it('16k input passes through sample count unchanged', () => {
    expect(downsampleTo16kPcm16(new Float32Array(160), 16000).length).toBe(160);
  });
});
