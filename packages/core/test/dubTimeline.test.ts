import { describe, expect, it } from 'vitest';
import { computeDubTimeline, type DubSegmentTiming } from '../src/file/dubTimeline';

// 实测四段译文音频时长（字节数 / 48 = ms @24k16bit mono）：4080 / 7920 / 7280 / 6880ms
const REAL: DubSegmentTiming[] = [
  { seq: 0, srcStartMs: 0, srcEndMs: 4600, dubDurationMs: 4080 },
  { seq: 1, srcStartMs: 4600, srcEndMs: 11800, dubDurationMs: 7920 },
  { seq: 2, srcStartMs: 11800, srcEndMs: 18800, dubDurationMs: 7280 },
  { seq: 3, srcStartMs: 18800, srcEndMs: 25000, dubDurationMs: 6880 },
];

describe('computeDubTimeline (spec 5.2 决策 D)', () => {
  it('starts each dub at max(srcStart, prevDubEnd) and accumulates drift', () => {
    expect(computeDubTimeline(REAL)).toEqual([
      { seq: 0, dubStartMs: 0, dubEndMs: 4080, driftMs: 0 },       // 译文短于原段，无漂移
      { seq: 1, dubStartMs: 4600, dubEndMs: 12520, driftMs: 0 },   // 原段起点晚于上段配音结束
      { seq: 2, dubStartMs: 12520, dubEndMs: 19800, driftMs: 720 }, // 被上段顺延 720ms
      { seq: 3, dubStartMs: 19800, dubEndMs: 26680, driftMs: 1000 },
    ]);
  });

  it('sorts by srcStartMs before placing', () => {
    const shuffled = [REAL[2]!, REAL[0]!, REAL[3]!, REAL[1]!];
    expect(computeDubTimeline(shuffled).map((p) => p.seq)).toEqual([0, 1, 2, 3]);
  });

  it('returns empty for empty input', () => {
    expect(computeDubTimeline([])).toEqual([]);
  });
});
