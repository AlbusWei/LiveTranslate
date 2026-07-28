import { TranscriptModel } from './transcriptModel';
import type { ITranslateTransport, NormalizedKind, SessionConfig } from '../protocol/types';

export type OrchestratorState = 'idle' | 'running' | 'paused' | 'reconnecting' | 'error';

const BACKOFF_MS = [500, 1000, 2000, 4000, 4000]; // R3：上限 5 次
const ALL_KINDS: NormalizedKind[] = [
  'session-created', 'session-updated', 'session-finished', 'speech-started', 'speech-stopped',
  'asr-delta', 'asr-completed', 'response-created', 'translation-delta', 'translation-done',
  'audio-delta', 'response-done', 'server-error',
];

export interface OrchestratorOptions {
  config: SessionConfig;
  transportFactory: () => ITranslateTransport;
  onStateChange?: (state: OrchestratorState) => void;
}

export class SessionOrchestrator {
  readonly model = new TranscriptModel();
  state: OrchestratorState = 'idle';
  transport: ITranslateTransport | null = null;
  private paused = false;
  private offs: Array<() => void> = [];

  constructor(private opts: OrchestratorOptions) {}

  private setState(s: OrchestratorState): void {
    this.state = s;
    this.opts.onStateChange?.(s);
  }

  async start(): Promise<void> {
    const t = this.opts.transportFactory();
    this.transport = t;
    for (const k of ALL_KINDS) {
      this.offs.push(t.on(k, (ev) => this.model.apply(ev)));
    }
    await t.connect(this.opts.config);
    this.paused = false;
    this.setState('running');
  }

  pushAudio(pcm16: ArrayBuffer): void {
    if (this.state !== 'running' || this.paused) return; // R4：暂停=停止 append
    this.transport?.appendAudio(pcm16);
  }

  pause(): void {
    this.paused = true;
    this.setState('paused');
  }

  resume(): void {
    this.paused = false;
    this.setState('running');
  }

  async stop(): Promise<void> {
    await this.transport?.finish();
    this.teardown();
    this.setState('idle');
  }

  async reset(): Promise<void> {
    this.transport?.abort(); // R4：重置 = abort + 新 session + 清屏
    this.teardown();
    this.model.reset();
    await this.start();
  }

  handleDisconnect(): void {
    this.model.markInterrupted(); // R3：进行中段落标中断
    this.teardown();
    this.setState('reconnecting');
    this.scheduleReconnect(0);
  }

  private scheduleReconnect(attempt: number): void {
    if (attempt >= BACKOFF_MS.length) {
      this.setState('error');
      return;
    }
    setTimeout(() => {
      void this.start().catch(() => this.scheduleReconnect(attempt + 1));
    }, BACKOFF_MS[attempt]);
  }

  private teardown(): void {
    this.offs.forEach((off) => off());
    this.offs = [];
    this.transport = null;
  }
}
