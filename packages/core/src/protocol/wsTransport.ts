import { Emitter } from './emitter';
import { normalizeServerEvent } from './normalize';
import { bytesToBase64 } from '../audio/base64';
import type {
  ITranslateTransport, NormalizedEvent, NormalizedKind, RawDirection, ServerEvent, SessionConfig,
} from './types';

// 浏览器 WebSocket / Node ws 都能适配的最小接口；测试用 FakeWs 实现。
export interface WsLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: (() => void) | null;
  onerror: ((err: unknown) => void) | null;
}

export interface WsTransportOptions {
  url: string; // 网关中继地址（Task 8），非百炼直连；Key 永不经过渲染端
  wsFactory: (url: string) => WsLike;
  finishTimeoutMs?: number; // P3 兜底，默认 10s
}

type EventMap = { [K in NormalizedKind]: Extract<NormalizedEvent, { kind: K }> };

export class WsTransport implements ITranslateTransport {
  readonly kind = 'ws' as const;
  private ws: WsLike | null = null;
  private emitter = new Emitter<EventMap>();
  private rawTaps = new Set<(dir: RawDirection, payload: ServerEvent) => void>();
  private finishTimeoutMs: number;

  constructor(private opts: WsTransportOptions) {
    this.finishTimeoutMs = opts.finishTimeoutMs ?? 10_000;
  }

  connect(cfg: SessionConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = this.opts.wsFactory(this.opts.url);
      this.ws = ws;
      let settled = false;
      ws.onerror = (err) => {
        if (!settled) {
          settled = true;
          if (this.ws === ws) this.ws = null; // 失败后不残留旧连接，允许重新 connect
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      ws.onmessage = (data) => {
        const ev = JSON.parse(data) as ServerEvent;
        this.rawTaps.forEach((tap) => tap('s2c', ev));
        if (ev.type === 'session.created') {
          this.sendJson({ type: 'session.update', session: cfg });
        }
        if (ev.type === 'session.updated' && !settled) {
          settled = true;
          resolve();
        }
        const norm = normalizeServerEvent(ev);
        if (norm) this.emitter.emit(norm.kind, norm as never);
      };
      ws.onopen = () => {
        // 百炼在建连后主动推 session.created（P2），这里无需发送任何东西
      };
      ws.onclose = () => {
        this.ws = null;
      };
    });
  }

  updateSession(patch: Partial<SessionConfig>): Promise<void> {
    this.sendJson({ type: 'session.update', session: patch });
    return Promise.resolve();
  }

  appendAudio(pcm16: ArrayBuffer): void {
    this.sendJson({ type: 'input_audio_buffer.append', audio: bytesToBase64(new Uint8Array(pcm16)) });
  }

  appendImage(jpegBase64: string): void {
    this.sendJson({ type: 'input_image_buffer.append', image: jpegBase64 });
  }

  finish(): Promise<void> {
    return new Promise((resolve) => {
      const ws = this.ws;
      if (!ws) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        off();
        ws.close(); // P3 兜底：服务端永不断链，超时强制断开
        resolve();
      }, this.finishTimeoutMs);
      const off = this.emitter.on('session-finished', () => {
        clearTimeout(timer);
        off();
        ws.close(); // P3：收到 finished 后客户端主动 close
        resolve();
      });
      this.sendJson({ type: 'session.finish' });
    });
  }

  abort(): void {
    this.ws?.close();
    this.ws = null;
  }

  on<K extends NormalizedKind>(kind: K, cb: (ev: Extract<NormalizedEvent, { kind: K }>) => void): () => void {
    return this.emitter.on(kind, cb);
  }

  onRaw(cb: (dir: RawDirection, payload: ServerEvent) => void): () => void {
    this.rawTaps.add(cb);
    return () => this.rawTaps.delete(cb);
  }

  getRemoteAudio(): MediaStream | null {
    return null;
  }

  private sendJson(obj: Record<string, unknown>): void {
    if (!this.ws) throw new Error('WsTransport: not connected');
    this.rawTaps.forEach((tap) => tap('c2s', obj as ServerEvent));
    this.ws.send(JSON.stringify(obj));
  }
}
