import { AudioSegmenter } from '../session/audioSegmenter';
import { TranscriptModel, type TranscriptSegment } from '../session/transcriptModel';
import { UsageMeter, type UsageSnapshot } from '../session/usageMeter';
import type { ITranslateTransport, NormalizedEvent, NormalizedKind, SessionConfig } from '../protocol/types';

export interface PipelineFrame {
  timeMs: number;
  jpegBase64: string;
}

export interface FilePipelineInput {
  pcm16k: Uint8Array; // 16k/16bit/mono 全量
  frames?: PipelineFrame[];
  config: SessionConfig;
  transport: ITranslateTransport;
  onProgress?: (doneMs: number, totalMs: number) => void; // 已结算段的 vadEndMs
  onEvent?: (ev: NormalizedEvent) => void;
}

export interface FilePipelineResult {
  segments: TranscriptSegment[];
  audioByResponseId: Map<string, Uint8Array>; // 24k PCM（P9）
  usage: UsageSnapshot;
}

const CHUNK_BYTES = 3200; // P7：100ms/块
const CHUNK_MS = 100;
const KINDS: NormalizedKind[] = [
  'session-created', 'session-updated', 'session-finished', 'speech-started', 'speech-stopped',
  'asr-delta', 'asr-completed', 'response-created', 'translation-delta', 'translation-done',
  'audio-delta', 'response-done', 'server-error',
];

export async function runFilePipeline(input: FilePipelineInput): Promise<FilePipelineResult> {
  const model = new TranscriptModel();
  const audioByResponseId = new Map<string, Uint8Array>();
  const segmenter = new AudioSegmenter((responseId, pcm24k) => audioByResponseId.set(responseId, pcm24k));
  const meter = new UsageMeter();
  const totalMs = Math.round(input.pcm16k.length / 32); // 32 字节/ms @16k16bit mono
  let usage = meter.snapshot();

  const offs = KINDS.map((k) =>
    input.transport.on(k, (ev) => {
      model.apply(ev);
      segmenter.apply(ev);
      if (ev.kind === 'response-done') {
        if (ev.usage) usage = meter.applyUsage(ev.usage); // P6 差分
        const seg = model.getSegments().find((s) => s.responseId === ev.responseId);
        if (seg && seg.vadEndMs !== null) input.onProgress?.(seg.vadEndMs, totalMs);
      }
      input.onEvent?.(ev);
    }),
  );

  await input.transport.connect(input.config);

  // P8：全速推流，循环内无任何 sleep；P11：帧在覆盖其时间戳的 append 之后发送
  const frames = [...(input.frames ?? [])].sort((a, b) => a.timeMs - b.timeMs);
  let frameIdx = 0;
  let sentMs = 0;
  for (let off = 0; off < input.pcm16k.length; off += CHUNK_BYTES) {
    const chunk = input.pcm16k.slice(off, off + CHUNK_BYTES);
    input.transport.appendAudio(chunk.buffer as ArrayBuffer);
    sentMs += CHUNK_MS;
    while (frameIdx < frames.length && frames[frameIdx]!.timeMs < sentMs) {
      input.transport.appendImage(frames[frameIdx]!.jpegBase64);
      frameIdx++;
    }
  }

  await input.transport.finish(); // P3：finish → finished → 客户端 close
  offs.forEach((off) => off());
  return { segments: model.getSegments().slice(), audioByResponseId, usage };
}
