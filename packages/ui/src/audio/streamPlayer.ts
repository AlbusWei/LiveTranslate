import { OUTPUT_SAMPLE_RATE } from '@livetranslate/core';

export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array;
}

export interface AudioSourceLike {
  buffer: AudioBufferLike | null;
  connect(dest: unknown): void;
  start(when: number): void;
  stop(): void;
}

export interface AudioContextLike {
  readonly currentTime: number;
  destination: unknown;
  createBuffer(numChannels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioSourceLike;
}

// P9：模型输出 24k PCM16；每个 audio-delta 解码后入队，无缝连播
export class StreamPlayer {
  private nextStartTime = 0;
  private sources: AudioSourceLike[] = [];

  constructor(private ctx: AudioContextLike, private sampleRate: number = OUTPUT_SAMPLE_RATE) {}

  enqueuePcm(pcm: Uint8Array): void {
    const samples = Math.floor(pcm.length / 2);
    if (samples === 0) return;
    const buf = this.ctx.createBuffer(1, samples, this.sampleRate);
    const ch = buf.getChannelData(0);
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let i = 0; i < samples; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const startAt = Math.max(this.ctx.currentTime, this.nextStartTime);
    src.start(startAt);
    this.nextStartTime = startAt + samples / this.sampleRate;
    this.sources.push(src);
  }

  bufferedSeconds(): number {
    return Math.max(0, this.nextStartTime - this.ctx.currentTime);
  }

  flush(): void {
    for (const s of this.sources) s.stop();
    this.sources = [];
    this.nextStartTime = 0;
  }
}
