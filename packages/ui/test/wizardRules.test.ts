import { describe, expect, it } from 'vitest';
import { isSuspectedSpeaker, makeTestTonePcm } from '../src/wizard/wizardRules';

describe('isSuspectedSpeaker (spec 5.3 回环自检)', () => {
  it('flags the system default output device', () => {
    expect(isSuspectedSpeaker({ deviceId: 'default', label: '默认 - 耳机 (WH-1000XM5)' })).toBe(true);
  });

  it('flags labels containing "speaker"', () => {
    expect(isSuspectedSpeaker({ deviceId: 'a1', label: 'Speakers (Realtek High Definition Audio)' })).toBe(true);
  });

  it('flags labels containing 扬声器', () => {
    expect(isSuspectedSpeaker({ deviceId: 'a2', label: '扬声器 (Realtek(R) Audio)' })).toBe(true);
  });

  it('passes explicit headphone devices', () => {
    expect(isSuspectedSpeaker({ deviceId: 'a3', label: '耳机 (WH-1000XM5 Stereo)' })).toBe(false);
  });
});

describe('makeTestTonePcm', () => {
  it('produces int16 mono pcm of the requested duration', () => {
    const pcm = makeTestTonePcm(1000, 100, 24000);
    expect(pcm.length).toBe(2400 * 2); // 100ms @24k，2 字节/采样
  });

  it('starts at zero crossing and peaks at 0.6 amplitude at quarter period', () => {
    const pcm = makeTestTonePcm(1000, 100, 24000); // 周期 = 24 采样，第 6 采样处 sin(π/2)=1
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(6 * 2, true)).toBeCloseTo(Math.round(0.6 * 32767), -1);
  });
});
