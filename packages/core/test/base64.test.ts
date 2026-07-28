import { describe, it, expect } from 'vitest';
import { bytesToBase64, base64ToBytes } from '../src/audio/base64';

describe('base64', () => {
  it('round-trips arbitrary bytes', () => {
    const src = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base64ToBytes(bytesToBase64(src))).toEqual(src);
  });

  it('handles a 3200-byte PCM chunk (P7 chunk size)', () => {
    const chunk = new Uint8Array(3200).map((_, i) => i % 256);
    const b64 = bytesToBase64(chunk);
    expect(b64.length % 4).toBe(0);
    expect(base64ToBytes(b64)).toEqual(chunk);
  });

  it('decodes the real first audio.delta prefix', () => {
    const real = 'AdaB2YHlwfIF/bMDfws/Fx8ffyH/J38vvzS/NH8yvzW/Mn8yPyk/In8YPxB/CXcBzv9Z+lH0wfBh8eHvIfCR8rn5';
    const bytes = base64ToBytes(real);
    expect(bytes.length).toBe(66);
  });

  it('round-trips empty input in both directions', () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
    expect(base64ToBytes('')).toEqual(new Uint8Array(0));
  });

  it('throws on illegal base64 characters', () => {
    expect(() => base64ToBytes('QUJ$')).toThrow(/invalid base64/i);
    expect(() => base64ToBytes('QUJD\u4e2d')).toThrow(/invalid base64/i); // code > 127 越界
  });
});
