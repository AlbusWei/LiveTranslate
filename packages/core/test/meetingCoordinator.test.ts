import { describe, expect, it } from 'vitest';
import { MeetingCoordinator, SILENCE_END_MS, TRANSLATING_TIMEOUT_MS } from '../src/meeting/meetingCoordinator';

// 可推进的假调度器：与 DubPlaybackDeps.schedule 同约定（返回取消函数）
class FakeScheduler {
  now = 0;
  private tasks: Array<{ cb: () => void; at: number; cancelled: boolean }> = [];
  schedule = (cb: () => void, delayMs: number): (() => void) => {
    const task = { cb, at: this.now + delayMs, cancelled: false };
    this.tasks.push(task);
    return () => { task.cancelled = true; };
  };
  advance(ms: number): void {
    this.now += ms;
    for (const t of this.tasks) {
      if (!t.cancelled && t.at <= this.now) { t.cancelled = true; t.cb(); }
    }
  }
}

function setup() {
  const clock = new FakeScheduler();
  const transitions: string[] = [];
  const coord = new MeetingCoordinator({
    schedule: clock.schedule,
    onStateChange: (s, speaker) => transitions.push(`${s}:${speaker ?? '-'}`),
  });
  return { clock, coord, transitions };
}

describe('MeetingCoordinator (spec 5.4 热座)', () => {
  it('walks the full hot-seat cycle idle→speaking→translating→playing→idle', () => {
    const { coord, transitions } = setup();
    expect(coord.requestSpeak('Alice')).toBe(true);
    coord.endSpeech();
    coord.notePlaybackStarted();
    coord.notePlaybackFinished();
    expect(transitions).toEqual(['speaking:Alice', 'translating:Alice', 'playing:Alice', 'idle:-']);
    expect(coord.speaker).toBeNull();
  });

  it('rejects requestSpeak while someone is speaking', () => {
    const { coord } = setup();
    coord.requestSpeak('Alice');
    expect(coord.requestSpeak('Bob')).toBe(false);
    expect(coord.speaker).toBe('Alice');
  });

  it('rejects requestSpeak during playing (按下无效)', () => {
    const { coord } = setup();
    coord.requestSpeak('Alice');
    coord.endSpeech();
    coord.notePlaybackStarted();
    expect(coord.requestSpeak('Bob')).toBe(false);
    expect(coord.state).toBe('playing');
  });

  it('auto-ends speech after 3s of VAD silence', () => {
    const { clock, coord } = setup();
    coord.requestSpeak('Alice');
    coord.noteSpeechStopped();
    clock.advance(SILENCE_END_MS - 1);
    expect(coord.state).toBe('speaking');
    clock.advance(1);
    expect(coord.state).toBe('translating');
  });

  it('cancels the silence timer when speech resumes', () => {
    const { clock, coord } = setup();
    coord.requestSpeak('Alice');
    coord.noteSpeechStopped();
    clock.advance(2000);
    coord.noteSpeechStarted(); // 发言人继续说话
    clock.advance(5000);
    expect(coord.state).toBe('speaking');
  });

  it('skipPlayback releases the seat immediately', () => {
    const { coord } = setup();
    coord.requestSpeak('Alice');
    coord.endSpeech();
    coord.notePlaybackStarted();
    coord.skipPlayback();
    expect(coord.state).toBe('idle');
    expect(coord.speaker).toBeNull();
  });

  it('ignores playback events outside their source states', () => {
    const { coord } = setup();
    coord.notePlaybackStarted(); // idle 中无效
    coord.notePlaybackFinished();
    expect(coord.state).toBe('idle');
    coord.requestSpeak('Alice');
    coord.notePlaybackFinished(); // speaking 中无效
    expect(coord.state).toBe('speaking');
  });

  it('noteResponseDone releases seat when translating without audio', () => {
    const { coord, transitions } = setup();
    coord.requestSpeak('Alice');
    coord.endSpeech();
    expect(coord.state).toBe('translating');
    coord.noteResponseDone(); // 无 audio-delta，response.done 直达
    expect(coord.state).toBe('idle');
    expect(coord.speaker).toBeNull();
    expect(transitions).toEqual(['speaking:Alice', 'translating:Alice', 'idle:-']);
  });

  it('noteResponseDone is a no-op when not translating', () => {
    const { coord } = setup();
    coord.requestSpeak('Alice');
    coord.noteResponseDone(); // speaking 中无效
    expect(coord.state).toBe('speaking');
  });

  it('translating timeout fires after TRANSLATING_TIMEOUT_MS and releases seat', () => {
    const { clock, coord } = setup();
    coord.requestSpeak('Alice');
    coord.endSpeech();
    expect(coord.state).toBe('translating');
    clock.advance(TRANSLATING_TIMEOUT_MS - 1);
    expect(coord.state).toBe('translating'); // 未超时
    clock.advance(1);
    expect(coord.state).toBe('idle'); // 超时强制释放
    expect(coord.speaker).toBeNull();
  });

  it('translating timeout is cleared when playback starts', () => {
    const { clock, coord } = setup();
    coord.requestSpeak('Alice');
    coord.endSpeech();
    coord.notePlaybackStarted(); // 进入 playing，应清除翻译超时
    clock.advance(TRANSLATING_TIMEOUT_MS + 1000); // 远超超时时间
    expect(coord.state).toBe('playing'); // 未被超时释放
  });
});
