import { describe, expect, it } from 'vitest';
import type { DubSegmentTiming } from '@livetranslate/core';
import { DubPlaybackController } from '../src/state/dubPlayback';

// 与 T22 相同的真实实测时长
const TIMINGS: DubSegmentTiming[] = [
  { seq: 0, srcStartMs: 0, srcEndMs: 4600, dubDurationMs: 4080 },
  { seq: 1, srcStartMs: 4600, srcEndMs: 11800, dubDurationMs: 7920 },
  { seq: 2, srcStartMs: 11800, srcEndMs: 18800, dubDurationMs: 7280 },
  { seq: 3, srcStartMs: 18800, srcEndMs: 25000, dubDurationMs: 6880 },
];

function fakeEnv() {
  let t = 0;
  const scheduled: Array<{ at: number; cb: () => void; cancelled: boolean; fired: boolean }> = [];
  const played: number[] = [];
  const controller = new DubPlaybackController({
    now: () => t,
    schedule: (cb, delayMs) => {
      const item = { at: t + delayMs, cb, cancelled: false, fired: false };
      scheduled.push(item);
      return () => { item.cancelled = true; };
    },
    playSegment: (seq) => played.push(seq),
  });
  const advance = (ms: number): void => {
    t += ms;
    for (const s of scheduled) {
      if (!s.cancelled && !s.fired && s.at <= t) { s.fired = true; s.cb(); }
    }
  };
  return { controller, advance, played };
}

describe('DubPlaybackController (spec 5.2 顺延回放)', () => {
  it('fires segments at their drifted start times in order', () => {
    const { controller, advance, played } = fakeEnv();
    controller.load(TIMINGS);
    controller.play();
    advance(0);
    expect(played).toEqual([0]); // dubStartMs=0 立即触发
    advance(4600);
    expect(played).toEqual([0, 1]);
    advance(7920); // t=12520 → seq2（被顺延到 12520）
    expect(played).toEqual([0, 1, 2]);
    expect(controller.currentSeq()).toBe(2);
    advance(7280); // t=19800 → seq3
    expect(played).toEqual([0, 1, 2, 3]);
    advance(6880); // t=26680，全部结束
    expect(controller.currentSeq()).toBeNull();
  });

  it('pause cancels pending segments and resume replays the remainder', () => {
    const { controller, advance, played } = fakeEnv();
    controller.load(TIMINGS);
    controller.play();
    advance(5000); // seq0/seq1 已触发
    controller.pause();
    expect(controller.positionMs()).toBe(5000);
    advance(60000); // 暂停期间时间流逝，不应触发任何段
    expect(played).toEqual([0, 1]);
    controller.play();
    advance(7520); // 5000+7520=12520 → seq2
    expect(played).toEqual([0, 1, 2]);
  });

  it('seek repositions without firing skipped segments', () => {
    const { controller, advance, played } = fakeEnv();
    controller.load(TIMINGS);
    controller.seek(19000);
    expect(controller.currentSeq()).toBe(2); // 19000 落在 seq2 的 12520–19800 区间
    controller.play();
    advance(800); // 19800 → 只有 seq3 到点
    expect(played).toEqual([3]);
  });
});
