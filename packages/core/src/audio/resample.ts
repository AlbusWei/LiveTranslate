// 采集链：AudioWorklet Float32 @设备采样率 → 16k Int16（spec §6.1）；直接抽取法，语音场景足够
export function downsampleTo16kPcm16(input: Float32Array, inputRate: number): Int16Array {
  const ratio = inputRate / 16000;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const v = input[Math.floor(i * ratio)]!;
    const clamped = Math.max(-1, Math.min(1, v));
    out[i] = Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767);
  }
  return out;
}
