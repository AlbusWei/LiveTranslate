import { describe, expect, it } from 'vitest';
import { computeDubTimeline, type DubSegmentTiming } from '../src/file/dubTimeline';
import { BYTES_PER_MS_24K, mixdownDubPcm } from '../src/file/dubMixdown';

// 真实实测四段：195840/380160/349440/330240 字节 = 4080/7920/7280/6880ms @24k
const TIMINGS: DubSegmentTiming[] = [
  { seq: 0, srcStartMs: 0, srcEndMs: 4600, dubDurationMs: 4080 },
  { seq: 1, srcStartMs: 4600, srcEndMs: 11800, dubDurationMs: 7920 },
  { seq: 2, srcStartMs: 11800, srcEndMs: 18800, dubDurationMs: 7280 },
  { seq: 3, srcStartMs: 18800, srcEndMs: 25000, dubDurationMs: 6880 },
];

describe('mixdownDubPcm (spec 5.2 混音 WAV)', () => {
  it('lays real-sized segments on the drift timeline over silence', () => {
    const audioBySeq = new Map<number, Uint8Array>([
      [0, new Uint8Array(195840).fill(1)],
      [1, new Uint8Array(380160).fill(2)],
      [2, new Uint8Array(349440).fill(3)],
      [3, new Uint8Array(330240).fill(4)],
    ]);
    const pcm = mixdownDubPcm({ placements: computeDubTimeline(TIMINGS), audioBySeq, totalMs: 25000 });
    // 末段顺延到 26680ms 结束 → 总长 26680 * 48 字节
    expect(pcm.length).toBe(26680 * BYTES_PER_MS_24K);
    expect(pcm[0]).toBe(1); // seq0 从 0ms 开始
    expect(pcm[4080 * BYTES_PER_MS_24K]).toBe(0); // 4080–4600ms 是静音间隙
    expect(pcm[4600 * BYTES_PER_MS_24K]).toBe(2); // seq1 从 4600ms 开始
    expect(pcm[12520 * BYTES_PER_MS_24K]).toBe(3); // seq2 被顺延到 12520ms
    expect(pcm[19800 * BYTES_PER_MS_24K]).toBe(4); // seq3 顺延到 19800ms
    expect(pcm[pcm.length - 1]).toBe(4); // 恰好在末段结尾处收尾
  });

  it('pads to totalMs when dubs finish earlier', () => {
    const pcm = mixdownDubPcm({
      placements: computeDubTimeline([{ seq: 0, srcStartMs: 0, srcEndMs: 1000, dubDurationMs: 500 }]),
      audioBySeq: new Map([[0, new Uint8Array(500 * BYTES_PER_MS_24K).fill(9)]]),
      totalMs: 1000,
    });
    expect(pcm.length).toBe(1000 * BYTES_PER_MS_24K);
    expect(pcm[500 * BYTES_PER_MS_24K]).toBe(0); // 后半段静音
  });
});
