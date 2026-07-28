import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WsTransport, type WsLike } from '../src/protocol/wsTransport';
import type { ServerEvent, SessionConfig } from '../src/protocol/types';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readJsonl = (f: string): ServerEvent[] =>
  readFileSync(join(FIX, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ServerEvent);

class FakeWs implements WsLike {
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.onclose?.();
  }
  // 测试辅助
  open(): void { this.onopen?.(); }
  push(ev: ServerEvent): void { this.onmessage?.(JSON.stringify(ev)); }
}

const CFG: SessionConfig = {
  modalities: ['text'],
  voice: 'Tina',
  sample_rate: 16000,
  input_audio_format: 'pcm',
  input_audio_transcription: { model: 'qwen3-asr-flash-realtime', language: 'zh' },
  translation: { language: 'en' },
};

function setup() {
  const fake = new FakeWs();
  const t = new WsTransport({ url: 'ws://gateway.test/realtime', wsFactory: () => fake });
  return { fake, t };
}

describe('WsTransport', () => {
  it('connect(): open → session.created → sends session.update → resolves on session.updated (P2)', async () => {
    const { fake, t } = setup();
    const p = t.connect(CFG);
    fake.open();
    fake.push({ type: 'session.created', session: { id: 'sess_1' } });
    expect(JSON.parse(fake.sent[0]!)).toEqual({ type: 'session.update', session: CFG });
    fake.push({ type: 'session.updated' });
    await expect(p).resolves.toBeUndefined();
    expect(t.kind).toBe('ws');
    expect(t.getRemoteAudio()).toBeNull();
  });

  it('replays the full real text turn and emits normalized events in order', async () => {
    const { fake, t } = setup();
    const kinds: string[] = [];
    (['asr-delta', 'translation-delta', 'translation-done', 'response-done', 'session-finished'] as const)
      .forEach((k) => t.on(k, (ev) => kinds.push(ev.kind)));
    const p = t.connect(CFG);
    fake.open();
    for (const ev of readJsonl('text-turn.jsonl')) fake.push(ev);
    await p;
    expect(kinds.filter((k) => k === 'asr-delta').length).toBe(3);
    expect(kinds.filter((k) => k === 'translation-delta').length).toBe(3);
    expect(kinds[kinds.length - 1]).toBe('session-finished');
  });

  it('appendAudio(): base64-encodes into input_audio_buffer.append (P7)', async () => {
    const { fake, t } = setup();
    const p = t.connect(CFG);
    fake.open();
    fake.push({ type: 'session.created', session: { id: 'sess_1' } });
    fake.push({ type: 'session.updated' });
    await p;
    const pcm = new Uint8Array(3200).fill(7);
    t.appendAudio(pcm.buffer);
    const msg = JSON.parse(fake.sent[1]!) as { type: string; audio: string };
    expect(msg.type).toBe('input_audio_buffer.append');
    expect(msg.audio.length).toBe(Math.ceil(3200 / 3) * 4);
  });

  it('appendImage(): sends input_image_buffer.append (P11)', async () => {
    const { fake, t } = setup();
    const p = t.connect(CFG);
    fake.open();
    fake.push({ type: 'session.created', session: { id: 'sess_1' } });
    fake.push({ type: 'session.updated' });
    await p;
    t.appendImage('aGVsbG8=');
    expect(JSON.parse(fake.sent[1]!)).toEqual({ type: 'input_image_buffer.append', image: 'aGVsbG8=' });
  });

  it('finish(): sends session.finish, closes AFTER session.finished (P3 client-side close)', async () => {
    const { fake, t } = setup();
    const p = t.connect(CFG);
    fake.open();
    fake.push({ type: 'session.created', session: { id: 'sess_1' } });
    fake.push({ type: 'session.updated' });
    await p;
    const fin = t.finish();
    expect(JSON.parse(fake.sent[1]!)).toEqual({ type: 'session.finish' });
    expect(fake.closed).toBe(false); // 服务端不断链，客户端必须自己 close
    fake.push({ type: 'session.finished' });
    await fin;
    expect(fake.closed).toBe(true);
  });

  it('finish(): force-closes after 10s if session.finished never arrives (P3 timeout)', async () => {
    vi.useFakeTimers();
    try {
      const { fake, t } = setup();
      const p = t.connect(CFG);
      fake.open();
      fake.push({ type: 'session.created', session: { id: 'sess_1' } });
      fake.push({ type: 'session.updated' });
      await p;
      const fin = t.finish();
      await vi.advanceTimersByTimeAsync(10_000);
      await fin;
      expect(fake.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('onRaw taps both directions for SessionLogger', async () => {
    const { fake, t } = setup();
    const taps: Array<[string, string]> = [];
    t.onRaw((dir, payload) => taps.push([dir, payload.type]));
    const p = t.connect(CFG);
    fake.open();
    fake.push({ type: 'session.created', session: { id: 'sess_1' } });
    fake.push({ type: 'session.updated' });
    await p;
    expect(taps).toEqual([
      ['s2c', 'session.created'],
      ['c2s', 'session.update'],
      ['s2c', 'session.updated'],
    ]);
  });

  it('connect(): rejects when the socket errors before session.updated', async () => {
    const { fake, t } = setup();
    const p = t.connect(CFG);
    fake.onerror?.(new Error('ECONNREFUSED'));
    await expect(p).rejects.toThrow('ECONNREFUSED');
  });

  it('connect(): can reconnect cleanly after a failed attempt (no stale state)', async () => {
    const fakes: FakeWs[] = [];
    const t = new WsTransport({
      url: 'ws://gateway.test/realtime',
      wsFactory: () => { const f = new FakeWs(); fakes.push(f); return f; },
    });
    const p1 = t.connect(CFG);
    fakes[0]!.onerror?.('boom'); // 非 Error 对象也要包装成 Error
    await expect(p1).rejects.toThrow('boom');
    const p2 = t.connect(CFG);
    fakes[1]!.open();
    fakes[1]!.push({ type: 'session.created', session: { id: 'sess_2' } });
    fakes[1]!.push({ type: 'session.updated' });
    await expect(p2).resolves.toBeUndefined();
    // session.update 只发到新连接，旧连接无残留写入
    expect(fakes[0]!.sent).toEqual([]);
    expect(fakes[1]!.sent.length).toBe(1);
  });
});
