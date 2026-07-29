import type { NormalizedEvent, Usage } from '../protocol/types';

export type SegmentStatus = 'listening' | 'translating' | 'done' | 'interrupted';

export interface TranscriptSegment {
  seq: number; // 1 起的会话内序号
  itemId: string | null; // VAD 段 item id
  responseId: string | null;
  status: SegmentStatus;
  sourceText: string; // ASR 已确认
  sourceStash: string; // ASR 暂存（浅灰斜体渲染）
  targetText: string; // 译文已确认
  targetStash: string; // 译文暂存
  sourceLang: string | null;
  emotion: string | null;
  vadStartMs: number | null;
  vadEndMs: number | null;
  usage: Usage | null; // 注意：session 累积值（P6），差分在 UsageMeter 做
  firstDeltaAt: number | null; // 首字延迟打点（epoch ms）
  doneAt: number | null;
}

function blank(seq: number): TranscriptSegment {
  return {
    seq, itemId: null, responseId: null, status: 'listening',
    sourceText: '', sourceStash: '', targetText: '', targetStash: '',
    sourceLang: null, emotion: null, vadStartMs: null, vadEndMs: null,
    usage: null, firstDeltaAt: null, doneAt: null,
  };
}

export class TranscriptModel {
  private segments: TranscriptSegment[] = [];
  private listeners = new Set<() => void>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  apply(ev: NormalizedEvent): void {
    switch (ev.kind) {
      case 'speech-started': {
        const seg = blank(this.segments.length + 1);
        seg.itemId = ev.itemId;
        seg.vadStartMs = ev.audioStartMs;
        this.segments.push(seg);
        break;
      }
      case 'speech-stopped': {
        const seg = this.byItem(ev.itemId);
        if (seg) seg.vadEndMs = ev.audioEndMs;
        break;
      }
      case 'asr-delta': {
        const seg = this.byItem(ev.itemId) ?? this.open();
        if (!seg) break;
        seg.itemId = seg.itemId ?? ev.itemId;
        // P4：整段覆盖，禁止拼接；但空 text 不覆盖已确认内容（防 stash-only 增量擦除历史确认）
        if (ev.text) seg.sourceText = ev.text;
        seg.sourceStash = ev.stash;
        seg.sourceLang = ev.language;
        seg.emotion = ev.emotion;
        break;
      }
      case 'asr-completed': {
        const seg = this.byItem(ev.itemId);
        if (!seg) break;
        seg.sourceText = ev.transcript;
        seg.sourceStash = '';
        seg.sourceLang = ev.language;
        seg.emotion = ev.emotion;
        break;
      }
      case 'response-created': {
        // 假定同一时刻只有一个未完成 response；若上游重叠下发，重叠的 response 合并进当前未完成段
        const seg = this.open() ?? this.pushBlank();
        seg.responseId = ev.responseId;
        seg.status = 'translating';
        break;
      }
      case 'translation-delta': {
        const seg = this.byResponse(ev.responseId);
        if (!seg) break;
        if (seg.firstDeltaAt === null) seg.firstDeltaAt = this.now();
        // P4：整段覆盖；但空 text 不覆盖已确认内容（防 stash-only 增量擦除历史确认）
        if (ev.text) seg.targetText = ev.text;
        seg.targetStash = ev.stash;
        break;
      }
      case 'translation-done': {
        const seg = this.byResponse(ev.responseId);
        if (!seg) break;
        seg.targetText = ev.text;
        seg.targetStash = '';
        break;
      }
      case 'response-done': {
        const seg = this.byResponse(ev.responseId);
        if (!seg) break;
        seg.usage = ev.usage;
        seg.status = 'done'; // R2：response.done 到达即结算
        seg.doneAt = this.now();
        break;
      }
      case 'session-created':
      case 'session-updated':
      case 'session-finished':
      case 'audio-delta': // 音频归 AudioSegmenter（Task 14），文本模型不处理
      case 'server-error':
        break;
    }
    this.listeners.forEach((l) => l());
  }

  markInterrupted(): void {
    for (const seg of this.segments) {
      if (seg.status === 'listening' || seg.status === 'translating') seg.status = 'interrupted';
    }
    this.listeners.forEach((l) => l());
  }

  getSegments(): readonly TranscriptSegment[] {
    return this.segments.slice(); // 防御性拷贝：防外部篡改内部数组
  }

  reset(): void {
    this.segments = [];
    this.listeners.forEach((l) => l());
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private byItem(itemId: string): TranscriptSegment | undefined {
    return this.segments.find((s) => s.itemId === itemId);
  }

  private byResponse(responseId: string): TranscriptSegment | undefined {
    return this.segments.find((s) => s.responseId === responseId);
  }

  private open(): TranscriptSegment | undefined {
    return [...this.segments].reverse().find((s) => s.status === 'listening' || s.status === 'translating');
  }

  private pushBlank(): TranscriptSegment {
    const seg = blank(this.segments.length + 1);
    this.segments.push(seg);
    return seg;
  }
}
