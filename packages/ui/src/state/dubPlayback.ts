import { computeDubTimeline, type DubPlacement, type DubSegmentTiming } from '@livetranslate/core';

export interface DubPlaybackDeps {
  now(): number; // 毫秒壁钟；页面用 performance.now()，测试注入假时钟
  schedule(cb: () => void, delayMs: number): () => void; // 返回取消函数
  playSegment(seq: number): void;
}

export class DubPlaybackController {
  private placements: DubPlacement[] = [];
  private basePositionMs = 0;
  private startedAt: number | null = null;
  private cancels: Array<() => void> = [];

  constructor(private deps: DubPlaybackDeps) {}

  load(timings: DubSegmentTiming[]): DubPlacement[] {
    this.pause();
    this.basePositionMs = 0;
    this.placements = computeDubTimeline(timings);
    return this.placements;
  }

  positionMs(): number {
    return this.startedAt === null
      ? this.basePositionMs
      : this.basePositionMs + (this.deps.now() - this.startedAt);
  }

  play(): void {
    if (this.startedAt !== null) return;
    this.startedAt = this.deps.now();
    const pos = this.basePositionMs;
    for (const p of this.placements) {
      if (p.dubStartMs >= pos) {
        this.cancels.push(this.deps.schedule(() => this.deps.playSegment(p.seq), p.dubStartMs - pos));
      }
    }
  }

  pause(): void {
    if (this.startedAt !== null) {
      this.basePositionMs = this.positionMs();
      this.startedAt = null;
    }
    this.cancels.forEach((cancel) => cancel());
    this.cancels = [];
  }

  seek(ms: number): void {
    const wasPlaying = this.startedAt !== null;
    this.pause();
    this.basePositionMs = Math.max(0, ms);
    if (wasPlaying) this.play();
  }

  currentSeq(): number | null {
    const pos = this.positionMs();
    const hit = this.placements.find((p) => p.dubStartMs <= pos && pos < p.dubEndMs);
    return hit ? hit.seq : null;
  }

  getPlacements(): DubPlacement[] {
    return this.placements;
  }
}
