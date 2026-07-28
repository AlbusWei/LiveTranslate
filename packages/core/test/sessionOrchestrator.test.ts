import { describe, it, expect, vi } from 'vitest';
import { SessionOrchestrator } from '../src/session/sessionOrchestrator';
import { Emitter } from '../src/protocol/emitter';
import type {
  ITranslateTransport, NormalizedEvent, NormalizedKind, RawDirection, ServerEvent, SessionConfig,
} from '../src/protocol/types';

type EventMap = { [K in NormalizedKind]: Extract<NormalizedEvent, { kind: K }> };

class FakeTransport implements ITranslateTransport {
  readonly kind = 'ws' as const;
  em = new Emitter<EventMap>();
  appended: ArrayBuffer[] = [];
  connectCalls = 0;
  finished = false;
  aborted = false;
  failNextConnect = false;
  connect(_cfg: SessionConfig): Promise<void> {
    this.connectCalls += 1;
    return this.failNextConnect ? Promise.reject(new Error('conn refused')) : Promise.resolve();
  }
  updateSession(): Promise<void> { return Promise.resolve(); }
  appendAudio(pcm16: ArrayBuffer): void { this.appended.push(pcm16); }
  appendImage(): void { /* 本测试不用 */ }
  finish(): Promise<void> { this.finished = true; return Promise.resolve(); }
  abort(): void { this.aborted = true; }
  on<K extends NormalizedKind>(kind: K, cb: (ev: EventMap[K]) => void): () => void { return this.em.on(kind, cb); }
  onRaw(_cb: (dir: RawDirection, payload: ServerEvent) => void): () => void { return () => undefined; }
  getRemoteAudio(): MediaStream | null { return null; }
  emit(ev: NormalizedEvent): void { this.em.emit(ev.kind, ev as never); }
}

const CFG: SessionConfig = {
  modalities: ['text'], voice: 'Tina', sample_rate: 16000, input_audio_format: 'pcm',
  input_audio_transcription: { model: 'qwen3-asr-flash-realtime' }, translation: { language: 'en' },
};

function setup(overrides: { failFirst?: boolean } = {}) {
  const transports: FakeTransport[] = [];
  const orch = new SessionOrchestrator({
    config: CFG,
    transportFactory: () => {
      const t = new FakeTransport();
      if (overrides.failFirst && transports.length === 0) t.failNextConnect = true;
      transports.push(t);
      return t;
    },
  });
  return { orch, transports };
}

describe('SessionOrchestrator', () => {
  it('start() connects and forwards audio; pause() gates appendAudio (R4)', async () => {
    const { orch, transports } = setup();
    await orch.start();
    orch.pushAudio(new ArrayBuffer(3200));
    orch.pause();
    orch.pushAudio(new ArrayBuffer(3200));
    orch.resume();
    orch.pushAudio(new ArrayBuffer(3200));
    expect(transports[0]!.appended.length).toBe(2); // 暂停期间的块被丢弃，session 保留
    expect(orch.state).toBe('running');
  });

  it('reset() aborts, clears model, starts a fresh session (R4)', async () => {
    const { orch, transports } = setup();
    await orch.start();
    transports[0]!.emit({ kind: 'speech-started', itemId: 'i1', audioStartMs: 0 });
    expect(orch.model.getSegments().length).toBe(1);
    await orch.reset();
    expect(transports[0]!.aborted).toBe(true);
    expect(orch.model.getSegments().length).toBe(0);
    expect(transports.length).toBe(2); // 新 session
  });

  it('stop() calls finish and transitions to idle', async () => {
    const { orch, transports } = setup();
    await orch.start();
    await orch.stop();
    expect(transports[0]!.finished).toBe(true);
    expect(orch.state).toBe('idle');
  });

  it('reconnects with exponential backoff 500/1000/2000/4000, max 5 (R3)', async () => {
    vi.useFakeTimers();
    try {
      const { orch, transports } = setup();
      await orch.start();
      transports[0]!.em.clear();
      orch.handleDisconnect(); // 模拟意外断线
      expect(orch.state).toBe('reconnecting');
      await vi.advanceTimersByTimeAsync(500);
      expect(transports.length).toBe(2);
      expect(orch.state).toBe('running');
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks in-flight segments interrupted on disconnect (R3)', async () => {
    vi.useFakeTimers();
    try {
      const { orch, transports } = setup();
      await orch.start();
      transports[0]!.emit({ kind: 'speech-started', itemId: 'i1', audioStartMs: 0 });
      orch.handleDisconnect();
      expect(orch.model.getSegments()[0]!.status).toBe('interrupted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after 5 failed reconnects and reports error state (R3)', async () => {
    vi.useFakeTimers();
    try {
      const transports: FakeTransport[] = [];
      const orch = new SessionOrchestrator({
        config: CFG,
        transportFactory: () => {
          const t = new FakeTransport();
          t.failNextConnect = transports.length >= 0; // 首连之后全部失败
          if (transports.length === 0) t.failNextConnect = false;
          transports.push(t);
          return t;
        },
      });
      await orch.start();
      orch.handleDisconnect();
      await vi.advanceTimersByTimeAsync(500 + 1000 + 2000 + 4000 + 4000 + 1000);
      expect(orch.state).toBe('error');
      expect(transports.length).toBe(1 + 5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards every normalized event to opts.onEvent (for AudioSegmenter/UsageMeter taps)', async () => {
    const t = new FakeTransport();
    const seen: string[] = [];
    const orch = new SessionOrchestrator({
      config: CFG,
      transportFactory: () => t,
      onEvent: (ev) => seen.push(ev.kind),
    });
    await orch.start();
    t.emit({ kind: 'session-created', sessionId: 'sess_tap' });
    t.emit({ kind: 'speech-started', itemId: 'item_tap', audioStartMs: 0 });
    expect(seen).toEqual(['session-created', 'speech-started']);
    // 模型同样收到（onEvent 是旁路 tap，不取代 model.apply）
    expect(orch.model.getSegments().length).toBeGreaterThan(0);
  });
});
