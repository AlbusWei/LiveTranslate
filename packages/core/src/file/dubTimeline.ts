export interface DubSegmentTiming {
  seq: number;
  srcStartMs: number; // 段在原始媒体中的 VAD 起点
  srcEndMs: number;
  dubDurationMs: number; // 译文音频实际时长（wavDurationSeconds * 1000）
}

export interface DubPlacement {
  seq: number;
  dubStartMs: number;
  dubEndMs: number;
  driftMs: number; // dubStartMs - srcStartMs，DriftBar（T24）直接显示
}

// spec §5.2 决策 D：不变速，第 n 段起点 = max(原段起点, 上一段配音结束)
export function computeDubTimeline(segments: DubSegmentTiming[]): DubPlacement[] {
  const sorted = [...segments].sort((a, b) => a.srcStartMs - b.srcStartMs);
  const placements: DubPlacement[] = [];
  let prevDubEnd = 0;
  for (const s of sorted) {
    const dubStartMs = Math.max(s.srcStartMs, prevDubEnd);
    const dubEndMs = dubStartMs + s.dubDurationMs;
    placements.push({ seq: s.seq, dubStartMs, dubEndMs, driftMs: dubStartMs - s.srcStartMs });
    prevDubEnd = dubEndMs;
  }
  return placements;
}
