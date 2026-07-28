import { describe, expect, it } from 'vitest';
import { StreamPlayer, type AudioBufferLike, type AudioContextLike, type AudioSourceLike } from '../src/audio/streamPlayer';

class FakeBuffer implements AudioBufferLike {
  data: Float32Array;
  constructor(length: number) { this.data = new Float32Array(length); }
  getChannelData(): Float32Array { return this.data; }
}

class FakeSource implements AudioSourceLike {
  buffer: AudioBufferLike | null = null;
  startedAt: number | null = null;
  stopped = false;
  connected = false;
  connect(): void { this.connected = true; }
  start(when: number): void { this.startedAt = when; }
  stop(): void { this.stopped = true; }
}

class FakeCtx implements AudioContextLike {
  currentTime = 0;
  destination = {};
  sources: FakeSource[] = [];
  createBuffer(_ch: number, length: number): AudioBufferLike { return new FakeBuffer(length); }
  createBufferSource(): AudioSourceLike {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
}

// 2400 采样 = 100ms @24k；小端 int16
const chunk100ms = (): Uint8Array => new Uint8Array(4800);

describe('StreamPlayer (spec 5.3 边收边播)', () => {
  it('schedules chunks back-to-back via nextStartTime accumulation', () => {
    const ctx = new FakeCtx();
    const p = new StreamPlayer(ctx);
    p.enqueuePcm(chunk100ms());
    p.enqueuePcm(chunk100ms());
    expect(ctx.sources[0]!.startedAt).toBe(0);
    expect(ctx.sources[1]!.startedAt).toBeCloseTo(0.1, 5);
    expect(p.bufferedSeconds()).toBeCloseTo(0.2, 5);
    expect(ctx.sources.every((s) => s.connected)).toBe(true);
  });

  it('resumes from currentTime after the queue drained (断流不置负时间)', () => {
    const ctx = new FakeCtx();
    const p = new StreamPlayer(ctx);
    p.enqueuePcm(chunk100ms()); // 队列到 0.1s
    ctx.currentTime = 1.0; // 早已播完
    p.enqueuePcm(chunk100ms());
    expect(ctx.sources[1]!.startedAt).toBe(1.0);
    expect(p.bufferedSeconds()).toBeCloseTo(0.1, 5);
  });

  it('converts little-endian int16 to float32 [-1,1)', () => {
    const ctx = new FakeCtx();
    const p = new StreamPlayer(ctx);
    // 两个采样：16384 (0x4000) → 0.5；-32768 (0x8000) → -1
    p.enqueuePcm(new Uint8Array([0x00, 0x40, 0x00, 0x80]));
    const data = (ctx.sources[0]!.buffer as FakeBuffer).data;
    expect(data[0]).toBeCloseTo(0.5, 5);
    expect(data[1]).toBe(-1);
  });

  it('flush stops all pending sources and resets the queue', () => {
    const ctx = new FakeCtx();
    const p = new StreamPlayer(ctx);
    p.enqueuePcm(chunk100ms());
    p.enqueuePcm(chunk100ms());
    p.flush();
    expect(ctx.sources.every((s) => s.stopped)).toBe(true);
    expect(p.bufferedSeconds()).toBe(0);
  });

  it('ignores empty chunks', () => {
    const ctx = new FakeCtx();
    const p = new StreamPlayer(ctx);
    p.enqueuePcm(new Uint8Array(0));
    expect(ctx.sources.length).toBe(0);
  });
});
