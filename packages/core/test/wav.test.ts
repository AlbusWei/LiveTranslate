import { describe, it, expect } from 'vitest';
import { pcm16ToWav, wavDurationSeconds } from '../src/audio/wav';

describe('wav (P9: output is 24kHz/16bit/mono)', () => {
  it('writes a 44-byte RIFF header with rate 24000', () => {
    const pcm = new Uint8Array(48000); // 1s @24k/16bit
    const wav = pcm16ToWav(pcm, 24000);
    expect(wav.length).toBe(44 + 48000);
    const dv = new DataView(wav.buffer);
    expect(String.fromCharCode(wav[0]!, wav[1]!, wav[2]!, wav[3]!)).toBe('RIFF');
    expect(dv.getUint32(24, true)).toBe(24000); // sample rate
    expect(dv.getUint32(28, true)).toBe(48000); // byte rate = rate*2
    expect(dv.getUint16(22, true)).toBe(1); // mono
    expect(dv.getUint32(40, true)).toBe(48000); // data size
  });

  it('duration helper: 48000 bytes @24k = 1s', () => {
    expect(wavDurationSeconds(48000, 24000)).toBe(1);
  });
});
