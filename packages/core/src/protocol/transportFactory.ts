import type {
  ITranslateTransport, NormalizedEvent, NormalizedKind, RawDirection, ServerEvent, SessionConfig,
} from './types';

export type ChannelReason = 'preferred' | 'fallback';

export interface AutoTransportOptions {
  makeWebRtc: () => ITranslateTransport;
  makeWs: () => ITranslateTransport;
  onChannelChosen?: (kind: 'ws' | 'webrtc', reason: ChannelReason) => void; // R5：UI 降级提示通道
}

interface EventSub {
  kind: NormalizedKind;
  cb: (ev: NormalizedEvent) => void;
  realOff: (() => void) | null;
  removed: boolean;
}

interface RawSub {
  cb: (dir: RawDirection, payload: ServerEvent) => void;
  realOff: (() => void) | null;
  removed: boolean;
}

export class AutoTransport implements ITranslateTransport {
  private inner: ITranslateTransport | null = null;
  private subs: EventSub[] = [];
  private rawSubs: RawSub[] = [];

  constructor(private opts: AutoTransportOptions) {}

  get kind(): 'ws' | 'webrtc' {
    return this.inner?.kind ?? 'ws';
  }

  async connect(cfg: SessionConfig): Promise<void> {
    // T17 时序：编排器先 on() 再 connect()，故订阅先落缓冲区，adopt 时回放到真正的传输上
    const rtc = this.opts.makeWebRtc();
    this.adopt(rtc);
    try {
      await rtc.connect(cfg);
      this.opts.onChannelChosen?.('webrtc', 'preferred');
      return;
    } catch {
      this.detach();
      rtc.abort(); // R5：WebRTC 不可用（白名单/网络），清理后降级
    }
    const ws = this.opts.makeWs();
    this.adopt(ws);
    await ws.connect(cfg); // WS 也失败则向上抛，交给编排层重连退避（R3）
    this.opts.onChannelChosen?.('ws', 'fallback');
  }

  updateSession(patch: Partial<SessionConfig>): Promise<void> {
    return this.req().updateSession(patch);
  }

  appendAudio(pcm16: ArrayBuffer): void {
    this.req().appendAudio(pcm16);
  }

  appendImage(jpegBase64: string): void {
    this.req().appendImage(jpegBase64);
  }

  finish(): Promise<void> {
    return this.inner ? this.inner.finish() : Promise.resolve();
  }

  abort(): void {
    this.inner?.abort();
    this.detach();
  }

  on<K extends NormalizedKind>(kind: K, cb: (ev: Extract<NormalizedEvent, { kind: K }>) => void): () => void {
    const sub: EventSub = {
      kind,
      cb: cb as (ev: NormalizedEvent) => void,
      realOff: this.inner ? this.inner.on(kind, cb) : null,
      removed: false,
    };
    this.subs.push(sub);
    return () => {
      sub.removed = true;
      sub.realOff?.();
      sub.realOff = null;
    };
  }

  onRaw(cb: (dir: RawDirection, payload: ServerEvent) => void): () => void {
    const sub: RawSub = { cb, realOff: this.inner ? this.inner.onRaw(cb) : null, removed: false };
    this.rawSubs.push(sub);
    return () => {
      sub.removed = true;
      sub.realOff?.();
      sub.realOff = null;
    };
  }

  getRemoteAudio(): MediaStream | null {
    return this.inner?.getRemoteAudio() ?? null;
  }

  private req(): ITranslateTransport {
    if (!this.inner) throw new Error('AutoTransport: not connected');
    return this.inner;
  }

  private adopt(t: ITranslateTransport): void {
    this.inner = t;
    for (const s of this.subs) if (!s.removed) s.realOff = t.on(s.kind, s.cb as never);
    for (const r of this.rawSubs) if (!r.removed) r.realOff = t.onRaw(r.cb);
  }

  private detach(): void {
    for (const s of this.subs) { s.realOff?.(); s.realOff = null; }
    for (const r of this.rawSubs) { r.realOff?.(); r.realOff = null; }
    this.inner = null;
  }
}
