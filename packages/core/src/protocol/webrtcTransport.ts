import { Emitter } from './emitter';
import { normalizeServerEvent } from './normalize';
import type {
  ITranslateTransport, NormalizedEvent, NormalizedKind, RawDirection, ServerEvent, SessionConfig,
} from './types';

export interface DataChannelLike {
  send(data: string): void;
  onmessage: ((data: string) => void) | null;
  onopen: (() => void) | null;
}

export interface PeerLike {
  createDataChannel(label: string): DataChannelLike;
  addTrack(track: MediaStreamTrack, stream: MediaStream): void;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(desc: { type: string; sdp?: string }): Promise<void>;
  setRemoteDescription(desc: { type: string; sdp: string }): Promise<void>;
  close(): void;
  ontrack: ((ev: { streams: readonly MediaStream[] }) => void) | null;
}

export interface WebRtcTransportOptions {
  peerFactory: () => PeerLike;
  sdpExchange: (offerSdp: string) => Promise<string>; // 网关 POST /webrtc/sdp
  getLocalStream: () => Promise<MediaStream>; // 向导选定的麦克风
  finishTimeoutMs?: number;
  connectTimeoutMs?: number;
}

type EventMap = { [K in NormalizedKind]: Extract<NormalizedEvent, { kind: K }> };

export class WebRtcTransport implements ITranslateTransport {
  readonly kind = 'webrtc' as const;
  private peer: PeerLike | null = null;
  private dc: DataChannelLike | null = null;
  private remoteStream: MediaStream | null = null;
  private emitter = new Emitter<EventMap>();
  private rawTaps = new Set<(dir: RawDirection, payload: ServerEvent) => void>();
  private finishTimeoutMs: number;
  private connectTimeoutMs: number;

  constructor(private opts: WebRtcTransportOptions) {
    this.finishTimeoutMs = opts.finishTimeoutMs ?? 10_000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
  }

  async connect(cfg: SessionConfig): Promise<void> {
    const peer = this.opts.peerFactory();
    this.peer = peer;
    const dc = peer.createDataChannel('events');
    this.dc = dc;
    peer.ontrack = (ev) => { this.remoteStream = ev.streams[0] ?? null; }; // 远端译音 RTP 轨
    const local = await this.opts.getLocalStream();
    for (const track of local.getAudioTracks()) peer.addTrack(track, local); // 麦风上行走 RTP（spec §4.2）
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const answerSdp = await this.opts.sdpExchange(offer.sdp ?? '');
    await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        peer.close();
        reject(new Error('WebRtcTransport: session.updated timeout')); // 白名单未开通时典型表现 → 交给 AutoTransport 降级
      }, this.connectTimeoutMs);
      dc.onmessage = (data) => {
        const ev = JSON.parse(data) as ServerEvent;
        this.rawTaps.forEach((tap) => tap('s2c', ev));
        if (ev.type === 'session.created') {
          this.sendJson({ type: 'session.update', session: cfg }); // P2 握手与 WS 完全一致
        }
        if (ev.type === 'session.updated') {
          clearTimeout(timer);
          resolve();
        }
        const norm = normalizeServerEvent(ev);
        if (norm) this.emitter.emit(norm.kind, norm as never);
      };
    });
  }

  updateSession(patch: Partial<SessionConfig>): Promise<void> {
    this.sendJson({ type: 'session.update', session: patch });
    return Promise.resolve();
  }

  appendAudio(_pcm16: ArrayBuffer): void {
    // 麦克风音频经 RTP 轨直达服务端（spec §4.2），data channel 不重复推流
  }

  appendImage(jpegBase64: string): void {
    this.sendJson({ type: 'input_image_buffer.append', image: jpegBase64 });
  }

  finish(): Promise<void> {
    return new Promise((resolve) => {
      const peer = this.peer;
      if (!peer || !this.dc) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        off();
        peer.close(); // P3 兑底：服务端永不断链，超时强制断开
        resolve();
      }, this.finishTimeoutMs);
      const off = this.emitter.on('session-finished', () => {
        clearTimeout(timer);
        off();
        peer.close(); // P3：收到 finished 后客户端主动断开
        resolve();
      });
      this.sendJson({ type: 'session.finish' });
    });
  }

  abort(): void {
    this.peer?.close();
    this.peer = null;
    this.dc = null;
  }

  on<K extends NormalizedKind>(kind: K, cb: (ev: Extract<NormalizedEvent, { kind: K }>) => void): () => void {
    return this.emitter.on(kind, cb);
  }

  onRaw(cb: (dir: RawDirection, payload: ServerEvent) => void): () => void {
    this.rawTaps.add(cb);
    return () => this.rawTaps.delete(cb);
  }

  getRemoteAudio(): MediaStream | null {
    return this.remoteStream;
  }

  private sendJson(obj: Record<string, unknown>): void {
    if (!this.dc) throw new Error('WebRtcTransport: not connected');
    this.rawTaps.forEach((tap) => tap('c2s', obj as ServerEvent));
    this.dc.send(JSON.stringify(obj));
  }
}
