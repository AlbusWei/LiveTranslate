import type { DubPlacement } from './dubTimeline';

export const BYTES_PER_MS_24K = 48; // 24000 采样/s × 2 字节 = 48 字节/ms（P9）

export interface MixdownInput {
  placements: DubPlacement[];
  audioBySeq: Map<number, Uint8Array>; // 各段 24k PCM（不含 WAV 头）
  totalMs: number; // 原始媒体总时长
}

// 静音底轨 + 按顺延时间轴铺段；顺延保证段间不重叠（T22），无需叠加混音
export function mixdownDubPcm(input: MixdownInput): Uint8Array {
  const endMs = Math.max(input.totalMs, ...input.placements.map((p) => p.dubEndMs), 0);
  const out = new Uint8Array(endMs * BYTES_PER_MS_24K);
  for (const p of input.placements) {
    const pcm = input.audioBySeq.get(p.seq);
    if (!pcm) continue;
    const offset = p.dubStartMs * BYTES_PER_MS_24K;
    out.set(pcm.subarray(0, Math.max(0, out.length - offset)), offset);
  }
  return out;
}
