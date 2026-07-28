import { describe, expect, it } from 'vitest';
import type { SessionConfig } from '../src/protocol/types';
import {
  WebRtcTransport, type DataChannelLike, type PeerLike,
} from '../src/protocol/webrtcTransport';

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

class FakeDc implements DataChannelLike {
  sent: string[] = [];
  onmessage: ((data: string) => void) | null = null;
  onopen: (() => void) | null = null;
  send(data: string): void { this.sent.push(data); }
  receive(obj: unknown): void { this.onmessage?.(JSON.stringify(obj)); }
}

class FakePeer implements PeerLike {
  dc = new FakeDc();
  addedTracks: MediaStreamTrack[] = [];
  remoteSdp: string | null = null;
  closed = false;
  ontrack: ((ev: { streams: readonly MediaStream[] }) => void) | null = null;
  createDataChannel(_label: string): DataChannelLike { return this.dc; }
  addTrack(track: MediaStreamTrack, _stream: MediaStream): void { this.addedTracks.push(track); }
  createOffer(): Promise<{ type: string; sdp?: string }> { return Promise.resolve({ type: 'offer', sdp: 'v=0\r\noffer' }); }
  setLocalDescription(_desc: { type: string; sdp?: string }): Promise<void> { return Promise.resolve(); }
  setRemoteDescription(desc: { type: string; sdp: string }): Promise<void> { this.remoteSdp = desc.sdp; return Promise.resolve(); }
  close(): void { this.closed = true; }
}

// core 测试跑在 Node，没有 DOM 全局；用结构假对象充当 MediaStream/Track
const fakeTrack = { kind: 'audio' } as unknown as MediaStreamTrack;
const fakeLocalStream = { getAudioTracks: () => [fakeTrack] } as unknown as MediaStream;

async function connected() {
  const peer = new FakePeer();
  const offers: string[] = [];
  const t = new WebRtcTransport({
    peerFactory: () => peer,
    sdpExchange: (offer) => { offers.push(offer); return Promise.resolve('v=0\r\nanswer'); },
    getLocalStream: () => Promise.resolve(fakeLocalStream),
    finishTimeoutMs: 50,
  });
  const done = t.connect(cfg);
  await new Promise((r) => setTimeout(r, 0)); // 等 offer/answer 微任务链跑完
  peer.dc.receive({ type: 'session.created', session: { id: 'sess_rtc_1' } });
  peer.dc.receive({ type: 'session.updated' });
  await done;
  return { peer, t, offers };
}

describe('WebRtcTransport', () => {
  it('performs sdp handshake then session.update handshake over data channel (P2)', async () => {
    const { peer, offers } = await connected();
    expect(offers).toEqual(['v=0\r\noffer']); // offer 交给 sdpExchange
    expect(peer.remoteSdp).toBe('v=0\r\nanswer'); // answer 回填 remote description
    expect(peer.addedTracks).toEqual([fakeTrack]); // 麦克风音轨上 RTP
    const first = JSON.parse(peer.dc.sent[0]!) as { type: string; session: SessionConfig };
    expect(first.type).toBe('session.update'); // created 后立即下发配置
    expect(first.session.voice).toBe('default'); // P10
  });

  it('treats appendAudio as a no-op because audio rides the RTP track', async () => {
    const { peer, t } = await connected();
    t.appendAudio(new ArrayBuffer(3200));
    expect(peer.dc.sent).toHaveLength(1); // 仍只有 session.update，没有 input_audio_buffer.append
  });

  it('sends images over the data channel', async () => {
    const { peer, t } = await connected();
    t.appendImage('/9j/4AAQSkZJRg==');
    const msg = JSON.parse(peer.dc.sent[1]!) as { type: string; image: string };
    expect(msg).toEqual({ type: 'input_image_buffer.append', image: '/9j/4AAQSkZJRg==' });
  });

  it('normalizes data-channel events exactly like the ws path (P4)', async () => {
    const { peer, t } = await connected();
    const texts: string[] = [];
    t.on('asr-delta', (ev) => texts.push(`${ev.text}|${ev.stash}`));
    peer.dc.receive({
      type: 'conversation.item.input_audio_transcription.text',
      item_id: 'item_rtc_1', text: '今天天气', stash: '很好', language: 'zh', emotion: 'neutral',
    });
    expect(texts).toEqual(['今天天气|很好']);
  });

  it('closes the peer after session.finished (P3) and on timeout fallback', async () => {
    const { peer, t } = await connected();
    const finishing = t.finish();
    peer.dc.receive({ type: 'session.finished' });
    await finishing;
    expect(peer.closed).toBe(true);
    const last = JSON.parse(peer.dc.sent[peer.dc.sent.length - 1]!) as { type: string };
    expect(last.type).toBe('session.finish');

    // 超时兑底：服务端不回 finished 也必须在 finishTimeoutMs 后 close
    const peer2 = new FakePeer();
    const t2 = new WebRtcTransport({
      peerFactory: () => peer2,
      sdpExchange: () => Promise.resolve('v=0\r\nanswer'),
      getLocalStream: () => Promise.resolve(fakeLocalStream),
      finishTimeoutMs: 20,
    });
    const done2 = t2.connect(cfg);
    await new Promise((r) => setTimeout(r, 0));
    peer2.dc.receive({ type: 'session.created', session: { id: 'sess_rtc_2' } });
    peer2.dc.receive({ type: 'session.updated' });
    await done2;
    await t2.finish();
    expect(peer2.closed).toBe(true);
  });

  it('exposes the remote RTP stream via getRemoteAudio', async () => {
    const { peer, t } = await connected();
    const remote = { id: 'remote-1' } as unknown as MediaStream;
    peer.ontrack?.({ streams: [remote] });
    expect(t.getRemoteAudio()).toBe(remote);
  });
});
