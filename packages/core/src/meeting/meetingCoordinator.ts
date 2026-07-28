export type HotSeatState = 'idle' | 'speaking' | 'translating' | 'playing';

export const SILENCE_END_MS = 3000; // spec §5.4：VAD 静音 ≥3s 自动结束发言

export interface CoordinatorDeps {
  schedule(cb: () => void, delayMs: number): () => void; // 返回取消函数；生产用 setTimeout/clearTimeout
  onStateChange?(state: HotSeatState, speaker: string | null): void;
}

export class MeetingCoordinator {
  state: HotSeatState = 'idle';
  speaker: string | null = null;
  private cancelSilence: (() => void) | null = null;

  constructor(private deps: CoordinatorDeps) {}

  private setState(s: HotSeatState): void {
    this.state = s;
    this.deps.onStateChange?.(s, this.speaker);
  }

  private clearSilenceTimer(): void {
    this.cancelSilence?.();
    this.cancelSilence = null;
  }

  // 热座抢占：仅 idle 可上座；translating/playing 中按下无效（spec §5.4）
  requestSpeak(name: string): boolean {
    if (this.state !== 'idle') return false;
    this.speaker = name;
    this.setState('speaking');
    return true;
  }

  noteSpeechStarted(): void {
    if (this.state !== 'speaking') return;
    this.clearSilenceTimer();
  }

  noteSpeechStopped(): void {
    if (this.state !== 'speaking') return;
    this.clearSilenceTimer();
    this.cancelSilence = this.deps.schedule(() => this.endSpeech(), SILENCE_END_MS);
  }

  // 手动结束发言或静音超时
  endSpeech(): void {
    if (this.state !== 'speaking') return;
    this.clearSilenceTimer();
    this.setState('translating');
  }

  notePlaybackStarted(): void {
    if (this.state !== 'translating') return;
    this.setState('playing');
  }

  notePlaybackFinished(): void {
    if (this.state !== 'playing') return;
    this.speaker = null;
    this.setState('idle');
  }

  // spec §5.4：跳过播放按钮，立即释放热座
  skipPlayback(): void {
    if (this.state !== 'playing') return;
    this.speaker = null;
    this.setState('idle');
  }
}
