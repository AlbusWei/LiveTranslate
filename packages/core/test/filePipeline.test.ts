import { describe, expect, it, vi } from 'vitest';
import { runFilePipeline } from '../src/file/filePipeline';
import type { ITranslateTransport, NormalizedEvent, NormalizedKind, SessionConfig } from '../src/protocol/types';

const CONFIG: SessionConfig = {
  modalities: ['text', 'audio'],
  voice: 'default',
  enable_voice_clone: true,
  voice_clone_options: { frequency: 'once' }, // spec §5.2 默认保留原片音色
  sample_rate: 16000,
  input_audio_format: 'pcm',
  input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
  translation: { language: 'en' },
};

class ScriptedTransport implements ITranslateTransport {
  readonly kind = 'ws' as const;
  calls: string[] = [];
  imagesAfterAppend: number[] = []; // 发图时已完成的音频 append 数
  private appended = 0;
  private handlers = new Map<NormalizedKind, Array<(ev: never) => void>>();

  constructor(private script: NormalizedEvent[]) {}

  async connect(): Promise<void> { this.calls.push('connect'); }
  async updateSession(): Promise<void> { this.calls.push('update'); }
  appendAudio(): void { this.appended++; this.calls.push('audio'); }
  appendImage(): void { this.imagesAfterAppend.push(this.appended); this.calls.push('image'); }
  abort(): void { this.calls.push('abort'); }
  onRaw(): () => void { return () => {}; }
  getRemoteAudio(): MediaStream | null { return null; }

  on<K extends NormalizedKind>(kind: K, cb: (ev: Extract<NormalizedEvent, { kind: K }>) => void): () => void {
    const arr = this.handlers.get(kind) ?? [];
    arr.push(cb as (ev: never) => void);
    this.handlers.set(kind, arr);
    return () => {};
  }

  async finish(): Promise<void> {
    this.calls.push('finish');
    for (const ev of this.script) {
      (this.handlers.get(ev.kind) ?? []).forEach((cb) => (cb as (e: NormalizedEvent) => void)(ev));
    }
  }
}

// 取自真实音频模态回合（audio-turn.jsonl 归一化后的形态；usage 为真实累积值 169）
const SCRIPT: NormalizedEvent[] = [
  { kind: 'session-created', sessionId: 'sess_file_1' },
  { kind: 'session-updated' },
  { kind: 'speech-started', itemId: 'item_f1', audioStartMs: 0 },
  { kind: 'asr-delta', itemId: 'item_f1', text: '今天天气很好，', stash: '我们', language: 'zh', emotion: 'neutral' },
  { kind: 'response-created', responseId: 'resp_f1' },
  { kind: 'translation-delta', responseId: 'resp_f1', text: 'The weather is very nice today,', stash: " let's" },
  { kind: 'audio-delta', responseId: 'resp_f1', base64: 'AdaB2YHlwfIF/gL4Adj/3P7g/+MBxwHZAtkA2P/G/7v/xACWAJUBhQGcAK7/pP6q/qb/PACJAF4AegDsAG8A' },
  { kind: 'speech-stopped', itemId: 'item_f1', audioEndMs: 4600 },
  { kind: 'translation-done', responseId: 'resp_f1', text: "The weather is very nice today, let's go for a walk in the park together.  " },
  { kind: 'asr-completed', itemId: 'item_f1', transcript: '今天天气很好，我们一起去公园散步。', language: 'zh', emotion: 'neutral' },
  {
    kind: 'response-done', responseId: 'resp_f1',
    usage: {
      total_tokens: 169, input_tokens: 85, output_tokens: 84,
      input_tokens_details: { text_tokens: 50, audio_tokens: 35 },
      output_tokens_details: { text_tokens: 33, audio_tokens: 51 },
    },
  },
  { kind: 'session-finished' },
];

describe('runFilePipeline (spec 5.2, P8/P11)', () => {
  it('pushes all audio full-speed with no timers, then finishes (P8)', async () => {
    vi.useFakeTimers(); // 若实现里有任何 sleep，此测试将超时挂死
    const t = new ScriptedTransport(SCRIPT);
    const result = await runFilePipeline({ pcm16k: new Uint8Array(32000), config: CONFIG, transport: t });
    vi.useRealTimers();
    // 32000 字节 = 10 块（3200 字节/块，P7）
    expect(t.calls.filter((c) => c === 'audio').length).toBe(10);
    expect(t.calls[0]).toBe('connect');
    expect(t.calls[t.calls.length - 1]).toBe('finish');
    expect(result.segments.length).toBe(1);
  });

  it('sends each frame only after the append covering its timestamp (P11)', async () => {
    const t = new ScriptedTransport(SCRIPT);
    await runFilePipeline({
      pcm16k: new Uint8Array(32000), // 1000ms
      frames: [
        { timeMs: 0, jpegBase64: 'ZnJhbWUw' },
        { timeMs: 450, jpegBase64: 'ZnJhbWUx' },
      ],
      config: CONFIG,
      transport: t,
    });
    // 首帧在第 1 块（覆盖 0–100ms）之后；450ms 帧在第 5 块（覆盖 400–500ms）之后
    expect(t.imagesAfterAppend).toEqual([1, 5]);
  });

  it('collects segments, per-response 24k audio and diffed usage from replay', async () => {
    const t = new ScriptedTransport(SCRIPT);
    const doneMs: number[] = [];
    const result = await runFilePipeline({
      pcm16k: new Uint8Array(32000), config: CONFIG, transport: t,
      onProgress: (ms) => doneMs.push(ms),
    });
    const seg = result.segments[0]!;
    expect(seg.targetText).toBe("The weather is very nice today, let's go for a walk in the park together.  ");
    expect(seg.sourceText).toBe('今天天气很好，我们一起去公园散步。');
    expect(seg.vadEndMs).toBe(4600);
    expect(result.audioByResponseId.get('resp_f1')!.length).toBe(63); // 计划勘误：84 字符 base64 = 63 字节（计划误写 88/66）
    expect(result.usage.lastDelta.total_tokens).toBe(169); // P6 差分（首段差分=累积值）
    expect(doneMs).toEqual([4600]);
  });
});
