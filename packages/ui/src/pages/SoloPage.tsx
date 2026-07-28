import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { TranscriptModel, WsTransport, type SessionConfig } from '@livetranslate/core';
import { getPlatform } from '../platform';
import { TranscriptView } from '../components/TranscriptView';
import { startMicCapture, type MicCaptureHandle } from '../audio/micCapture';

function browserWsFactory(url: string) {
  const ws = new WebSocket(url);
  const like = {
    send: (d: string) => ws.send(d),
    close: () => ws.close(),
    onopen: null as (() => void) | null,
    onmessage: null as ((data: string) => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as ((err: unknown) => void) | null,
  };
  ws.onopen = () => like.onopen?.();
  ws.onmessage = (e) => like.onmessage?.(String(e.data));
  ws.onclose = () => like.onclose?.();
  ws.onerror = (e) => like.onerror?.(e);
  return like;
}

export function SoloPage(): JSX.Element {
  const model = useMemo(() => new TranscriptModel(), []);
  const [, force] = useReducer((n: number) => n + 1, 0);
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const busyRef = useRef(false); // 同步守卫：state 在同一 tick 连点时尚未 flush，单靠 starting 会双建会话
  const transportRef = useRef<WsTransport | null>(null);
  const micRef = useRef<MicCaptureHandle | null>(null);

  useEffect(() => model.onChange(force), [model]);

  // 卸载清理：路由切走时停止采集、断开连接，不留后台泄漏
  useEffect(() => () => {
    micRef.current?.stop();
    micRef.current = null;
    transportRef.current?.abort();
    transportRef.current = null;
  }, []);

  async function start(): Promise<void> {
    if (busyRef.current || running) return; // 防重入：连点不重复创建 mic/transport
    busyRef.current = true;
    setStarting(true);
    const cfg: SessionConfig = {
      modalities: ['text'],
      voice: 'Tina',
      sample_rate: 16000,
      input_audio_format: 'pcm',
      input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
      translation: { language: 'en' },
    };
    const t = new WsTransport({ url: getPlatform().gatewayWsUrl(), wsFactory: browserWsFactory });
    (['session-created', 'session-updated', 'session-finished', 'speech-started', 'speech-stopped',
      'asr-delta', 'asr-completed', 'response-created', 'translation-delta', 'translation-done',
      'audio-delta', 'response-done', 'server-error'] as const)
      .forEach((k) => t.on(k, (ev) => model.apply(ev)));
    try {
      await t.connect(cfg);
      transportRef.current = t;
      micRef.current = await startMicCapture({ onChunk: (b) => t.appendAudio(b) });
      setRunning(true);
    } catch (err) {
      micRef.current?.stop();
      micRef.current = null;
      t.abort();
      transportRef.current = null;
      console.error('[solo] start failed:', err);
    } finally {
      setStarting(false);
      busyRef.current = false;
    }
  }

  async function stop(): Promise<void> {
    micRef.current?.stop();
    micRef.current = null;
    await transportRef.current?.finish();
    transportRef.current = null;
    setRunning(false);
  }

  return (
    <div>
      <h2>单人测试（文本流）</h2>
      {!running
        ? <button onClick={() => void start()} disabled={running || starting}>开始</button>
        : <button onClick={() => void stop()}>结束</button>}
      <TranscriptView segments={model.getSegments()} />
    </div>
  );
}
