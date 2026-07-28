// 声道向导纯逻辑：不碰浏览器 API，可单测（spec §5.3 步骤③回环自检）。

// 判定输出设备疑似“外放扬声器”：系统默认设备（无法确认实体）或名称含 speaker/扬声器。
export function isSuspectedSpeaker(dev: { deviceId: string; label: string }): boolean {
  if (dev.deviceId === 'default') return true;
  return /speaker|扬声器/i.test(dev.label);
}

// 生成正弦测试音（0.6 幅度防爆音），PCM16 小端单声道，配合 pcm16ToWav 播放。
export function makeTestTonePcm(freqHz: number, durationMs: number, sampleRate: number): Uint8Array {
  const samples = Math.round((durationMs / 1000) * sampleRate);
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples; i++) {
    const v = Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * 0.6;
    view.setInt16(i * 2, Math.round(v * 32767), true);
  }
  return out;
}
