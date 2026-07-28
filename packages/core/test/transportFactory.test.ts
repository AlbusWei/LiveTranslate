import { describe, expect, it } from 'vitest';
import { AutoTransport } from '../src/protocol/transportFactory';
import type {
  ITranslateTransport, NormalizedEvent, NormalizedKind, RawDirection, ServerEvent, SessionConfig,
} from '../src/protocol/types';

const cfg: SessionConfig = {
  modalities: ['text', 'audio'],
  voice: 'default',
  enable_voice_clone: true,
  voice_clone_options: { frequency: 'once' },
  sample_rate: 16000,
  input_audio_format: 'pcm',
  input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
  translation: { language: 'en' },
};

class FakeTransport implements ITranslateTransport {
  connectCalls = 0;
  aborted = false;
  audio: ArrayBuffer[] = [];
  finished = false;
  private listeners = new Map<NormalizedKind, Set<(ev: never) => void>>();
  constructor(readonly kind: 'ws' | 'webrtc', private failConnect = false) {}
  connect(_cfg: SessionConfig): Promise<void> {
    this.connectCalls += 1;
    return this.failConnect ? Promise.reject(new Error('sdp exchange failed: 403')) : Promise.resolve();
  }
  emit(ev: NormalizedEvent): void { this.listeners.get(ev.kind)?.forEach((cb) => cb(ev as never)); }
  on<K extends NormalizedKind>(kind: K, cb: (ev: Extract<NormalizedEvent, { kind: K }>) => void): () => void {
    let set = this.listeners.get(kind);
    if (!set) { set = new Set(); this.listeners.set(kind, set); }
    const s = set;
    s.add(cb as (ev: never) => void);
    return () => s.delete(cb as (ev: never) => void);
  }
  onRaw(_cb: (dir: RawDirection, payload: ServerEvent) => void): () => void { return () => undefined; }
  updateSession(_patch: Partial<SessionConfig>): Promise<void> { return Promise.resolve(); }
  appendAudio(pcm16: ArrayBuffer): void { this.audio.push(pcm16); }
  appendImage(_jpegBase64: string): void { /* 降级测试用不到图像 */ }
  finish(): Promise<void> { this.finished = true; return Promise.resolve(); }
  abort(): void { this.aborted = true; }
  getRemoteAudio(): MediaStream | null { return null; }
}

function makeAuto(rtcFails: boolean) {
  const rtc = new FakeTransport('webrtc', rtcFails);
  const ws = new FakeTransport('ws');
  const chosen: Array<[string, string]> = [];
  const auto = new AutoTransport({
    makeWebRtc: () => rtc,
    makeWs: () => ws,
    onChannelChosen: (kind, reason) => chosen.push([kind, reason]),
  });
  return { auto, rtc, ws, chosen };
}

describe('AutoTransport', () => {
  it('prefers webrtc when its handshake succeeds', async () => {
    const { auto, rtc, ws, chosen } = makeAuto(false);
    await auto.connect(cfg);
    expect(rtc.connectCalls).toBe(1);
    expect(ws.connectCalls).toBe(0);
    expect(auto.kind).toBe('webrtc');
    expect(chosen).toEqual([['webrtc', 'preferred']]);
  });

  it('falls back to ws when webrtc connect rejects (R5)', async () => {
    const { auto, rtc, ws, chosen } = makeAuto(true);
    await auto.connect(cfg);
    expect(rtc.aborted).toBe(true); // 失败的 peer 必须清理
    expect(ws.connectCalls).toBe(1);
    expect(auto.kind).toBe('ws');
    expect(chosen).toEqual([['ws', 'fallback']]);
  });

  it('replays subscriptions made before connect onto the adopted transport', async () => {
    // T17 时序：SessionOrchestrator.start() 先 on(ALL_KINDS) 再 connect()，订阅不能丢
    const { auto, rtc, ws } = makeAuto(true);
    const texts: string[] = [];
    const off = auto.on('asr-delta', (ev) => texts.push(ev.text));
    await auto.connect(cfg);
    ws.emit({ kind: 'asr-delta', itemId: 'item_a1', text: '今天', stash: '天气', language: 'zh', emotion: 'neutral' });
    expect(texts).toEqual(['今天']);
    rtc.emit({ kind: 'asr-delta', itemId: 'item_a1', text: '不应该出现', stash: '', language: 'zh', emotion: 'neutral' });
    expect(texts).toEqual(['今天']); // 被抛弃的 rtc 上的订阅已解除
    off();
    ws.emit({ kind: 'asr-delta', itemId: 'item_a1', text: '退订后不收', stash: '', language: 'zh', emotion: 'neutral' });
    expect(texts).toEqual(['今天']);
  });

  it('delegates audio, finish and kind to the adopted inner transport', async () => {
    const { auto, ws } = makeAuto(true);
    await auto.connect(cfg);
    const buf = new ArrayBuffer(3200);
    auto.appendAudio(buf);
    expect(ws.audio).toEqual([buf]);
    await auto.finish();
    expect(ws.finished).toBe(true);
    expect(auto.getRemoteAudio()).toBeNull();
  });
});
