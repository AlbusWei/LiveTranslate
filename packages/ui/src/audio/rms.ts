// RMS 音量（0..1），供音量条与声道向导使用（spec §5.3）。
export function rmsLevel(f32: Float32Array): number {
  if (f32.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < f32.length; i++) sum += f32[i]! * f32[i]!;
  return Math.sqrt(sum / f32.length);
}
