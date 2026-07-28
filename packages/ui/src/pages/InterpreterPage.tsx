import { useEffect, useRef, useState } from 'react';
import {
  LANGUAGES, OUTPUT_SAMPLE_RATE, SessionOrchestrator, UsageMeter, WsTransport,
  base64ToBytes, supportsAudioOutput,
  type NormalizedEvent, type OrchestratorState, type SessionConfig, type TranscriptSegment,
} from '@livetranslate/core';
import { getPlatform } from '../platform';
import { browserWsFactory } from '../wsFactory';
import { createGatewayApi, createSessionRecord, finishSessionRecord, postSegmentRecord } from '../api';
import { startMicCapture, type MicCaptureHandle } from '../audio/micCapture';
import { StreamPlayer } from '../audio/streamPlayer';
import { ChannelWizard, type ChannelChoice } from '../wizard/ChannelWizard';

export function InterpreterPage(): JSX.Element {
  const [choice, setChoice] = useState<ChannelChoice | null>(null); // 每次进页强制重走向导（spec §5.3）
  const [state, setState] = useState<OrchestratorState>('idle');
  const [sourceLanguage, setSourceLanguage] = useState('auto');
  const [targetLanguage, setTargetLanguage] = useState('en');
  const [useClone, setUseClone] = useState(true); // 默认 once 复刻
  const [defaultVoice, setDefaultVoice] = useState('Tina');
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [segments, setSegments] = useState<readonly TranscriptSegment[]>([]);
  const [startError, setStartError] = useState<string | null>(null);

  const orchRef = useRef<SessionOrchestrator | null>(null);
  const micRef = useRef<MicCaptureHandle | null>(null);
  const playerRef = useRef<StreamPlayer | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const speechStartedAtRef = useRef<number | null>(null);
  const meterRef = useRef(new UsageMeter());

  useEffect(() => {
    void createGatewayApi().getSettings().then((r) => {
      setSourceLanguage(r.settings.sourceLanguage || 'auto');
      setTargetLanguage(r.settings.targetLanguage || 'en');
      setDefaultVoice(r.settings.defaultVoice || 'Tina');
    });
  }, []);

  function buildConfig(): SessionConfig {
    return {
      modalities: ['text', 'audio'], // 实时翻译机必须放音
      voice: useClone ? 'default' : defaultVoice, // P10：复刻时 voice 必须 "default"
      ...(useClone ? { enable_voice_clone: true, voice_clone_options: { frequency: 'once' as const } } : {}),
      sample_rate: 16000,
      input_audio_format: 'pcm',
      input_audio_transcription: {
        model: 'qwen3-asr-flash-realtime',
        ...(sourceLanguage !== 'auto' ? { language: sourceLanguage } : {}),
      },
      translation: { language: targetLanguage },
    };
  }

  function persistDoneSegment(responseId: string): void {
    const sessionId = sessionIdRef.current;
    const seg = orchRef.current?.model.getSegments().find((s) => s.responseId === responseId);
    if (!sessionId || !seg) return;
    void postSegmentRecord({
      sessionId, seq: seg.seq, vadStartMs: seg.vadStartMs, vadEndMs: seg.vadEndMs,
      sourceText: seg.sourceText, targetText: seg.targetText,
      sourceLang: seg.sourceLang, emotion: seg.emotion,
      usageJson: seg.usage ? JSON.stringify(seg.usage) : null,
      // 实时模式不逐段存 WAV：音频已实时播出，历史页仅回看文本（§6.6 事件日志由网关中继自动落盘）
    });
  }

  function handleEvent(ev: NormalizedEvent): void {
    if (ev.kind === 'session-created') {
      sessionIdRef.current = ev.sessionId; // 与 relay 日志文件同键
      void createSessionRecord({ id: ev.sessionId, mode: 'interpreter', configJson: JSON.stringify(buildConfig()), startedAt: Date.now() });
    }
    if (ev.kind === 'speech-started') speechStartedAtRef.current = Date.now();
    if (ev.kind === 'translation-delta' && speechStartedAtRef.current !== null) {
      setLatencyMs(Date.now() - speechStartedAtRef.current); // 顶部延迟指示器：当前段首字延迟
      speechStartedAtRef.current = null;
    }
    if (ev.kind === 'audio-delta') playerRef.current?.enqueuePcm(base64ToBytes(ev.base64)); // T27 边收边播
    if (ev.kind === 'response-done') {
      if (ev.usage) meterRef.current.applyUsage(ev.usage); // P6 差分累计，结束时落盘
      persistDoneSegment(ev.responseId);
    }
  }

  async function start(): Promise<void> {
    if (!choice) return;
    const ctx = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE }); // P9：输出 24kHz
    const sinkable = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (sinkable.setSinkId) await sinkable.setSinkId(choice.outputDeviceId); // 向导选定的播音设备
    ctxRef.current = ctx;
    playerRef.current = new StreamPlayer(ctx);
    const orch = new SessionOrchestrator({
      config: buildConfig(),
      transportFactory: () => new WsTransport({ url: getPlatform().gatewayWsUrl(), wsFactory: browserWsFactory }),
      onStateChange: setState,
      onEvent: handleEvent,
    });
    orch.model.onChange(() => setSegments(orch.model.getSegments()));
    orchRef.current = orch;
    meterRef.current = new UsageMeter();
    setLatencyMs(null);
    setStartError(null);
    try {
      await orch.start();
      // D6：M4 仅 WS 通道，浏览器侧 AEC/NS 兑底回声
      micRef.current = await startMicCapture({
        deviceId: choice.inputDeviceId,
        echoCancellation: true,
        onChunk: (b) => orch.pushAudio(b),
      });
    } catch (err) {
      // B10 自审 #2：对齐 SoloPage 防护，启动失败不留 unhandled rejection
      micRef.current?.stop();
      micRef.current = null;
      orch.transport?.abort();
      orchRef.current = null;
      playerRef.current = null;
      void ctx.close();
      ctxRef.current = null;
      setState('idle');
      setStartError(err instanceof Error ? err.message : String(err));
    }
  }

  function pause(): void {
    micRef.current?.pause();
    orchRef.current?.pause(); // R4：保连接停推流
    playerRef.current?.flush(); // 暂停立即静音，不留残余队列
  }

  function resume(): void {
    micRef.current?.resume();
    orchRef.current?.resume();
  }

  async function stop(): Promise<void> {
    micRef.current?.stop();
    micRef.current = null;
    await orchRef.current?.stop(); // P3：finish → finished → 客户端 close（内部置 state='idle'）
    playerRef.current?.flush();
    playerRef.current = null;
    void ctxRef.current?.close();
    ctxRef.current = null;
    const sessionId = sessionIdRef.current;
    if (sessionId) {
      await finishSessionRecord({ id: sessionId, endedAt: Date.now(), usageJson: JSON.stringify(meterRef.current.snapshot().sessionTotal) });
    }
    sessionIdRef.current = null;
  }

  if (!choice) return <ChannelWizard onComplete={setChoice} />;

  const running = state === 'running' || state === 'paused' || state === 'reconnecting';
  if (!running) {
    const audioOk = supportsAudioOutput(targetLanguage);
    return (
      <div className="page-body">
        <h2>实时翻译机</h2>
        <p className="hint">
          收音：{choice.inputDeviceId.slice(0, 8)}… ｜ 播音：{choice.outputDeviceId.slice(0, 8)}…
          <button onClick={() => setChoice(null)}>重新配置声道</button>
        </p>
        <label>源语言
          <select value={sourceLanguage} onChange={(e) => setSourceLanguage(e.target.value)}>
            <option value="auto">自动检测</option>
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
        </label>
        <label>目标语言
          <select value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value)}>
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={useClone} onChange={(e) => setUseClone(e.target.checked)} />
          复刻我的音色（首句采样，once）
        </label>
        {!audioOk && <p className="error-text">该目标语言仅支持文本输出，无法启动实时翻译机，请改选支持语音的语言。</p>}
        {state === 'error' && <p className="error-text">重连失败，请检查网络后重新开始。</p>}
        {startError && <p className="error-text">启动失败：{startError}</p>}
        <button disabled={!audioOk} onClick={() => void start()}>开始翻译</button>
      </div>
    );
  }

  const latest = segments[segments.length - 1];
  return (
    <div className="interpreter-fullscreen">
      <header className="interpreter-topbar">
        <span className="channel-badge">{orchRef.current?.transport?.kind === 'webrtc' ? 'WebRTC' : 'WS'}</span>
        <span>首字延迟：{latencyMs === null ? '—' : `${latencyMs}ms`}</span>
        {state === 'running' && <button onClick={pause}>暂停</button>}
        {state === 'paused' && <button onClick={resume}>恢复</button>}
        <button onClick={() => void stop()}>结束</button>
        {state === 'reconnecting' && <span className="warn-banner">连接中断，正在重连……</span>}
      </header>
      <main className="subtitle-area">
        {latest ? (
          <>
            <p className="subtitle-source">
              {latest.sourceText}
              {latest.sourceStash && <span className="stash">{latest.sourceStash}</span>}
            </p>
            <p className="subtitle-target">
              {latest.targetText}
              {latest.targetStash && <span className="stash">{latest.targetStash}</span>}
            </p>
          </>
        ) : (
          <p className="subtitle-source">请开始说话……</p>
        )}
      </main>
    </div>
  );
}
