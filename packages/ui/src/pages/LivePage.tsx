import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AudioSegmenter, AutoTransport, LANGUAGES, OUTPUT_SAMPLE_RATE, SessionOrchestrator, UsageMeter,
  WebRtcTransport, WsTransport, base64ToBytes, bytesToBase64, pcm16ToWav, supportsAudioOutput, wavDurationSeconds,
  type ITranslateTransport, type NormalizedEvent, type OrchestratorState, type SessionConfig, type TranscriptSegment, type UsageSnapshot,
} from '@livetranslate/core';
import { Mic, Square, Pause, Play, RotateCcw, ChevronDown, Volume2 } from 'lucide-react';
import { getPlatform } from '../platform';
import { browserWsFactory } from '../wsFactory';
import { browserPeerFactory } from '../rtcFactory';
import { createGatewayApi, createSessionRecord, exchangeSdp, finishSessionRecord, postSegmentRecord, type AppSettingsDto } from '../api';
import { createPlayerSink } from '../audio/playerSink';
import { startMicCapture, type MicCaptureHandle } from '../audio/micCapture';
import { StreamPlayer } from '../audio/streamPlayer';
import { SubtitleOverlay } from '../components/SubtitleOverlay';
import { ChannelWizard, type ChannelChoice } from '../wizard/ChannelWizard';

interface SegmentAudio { wav: Uint8Array; durationSec: number; }
type Tab = 'text' | 'headphone';

export function LivePage(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: Tab = searchParams.get('tab') === 'headphone' ? 'headphone' : 'text';

  const [, force] = useReducer((n: number) => n + 1, 0);
  const [state, setState] = useState<OrchestratorState>('idle');
  const [starting, setStarting] = useState(false);
  const [sourceLanguage, setSourceLanguage] = useState('auto');
  const [targetLanguage, setTargetLanguage] = useState('en');
  const [withAudio, setWithAudio] = useState(false);
  const [hotwordTable, setHotwordTable] = useState('');
  const [hotwordTables, setHotwordTables] = useState<AppSettingsDto['hotwordTables']>([]);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [firstDeltaLatencyMs, setFirstDeltaLatencyMs] = useState<number | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null);

  // Headphone mode state
  const [choice, setChoice] = useState<ChannelChoice | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [segments, setSegments] = useState<readonly TranscriptSegment[]>([]);
  const [channelNotice, setChannelNotice] = useState<string | null>(null);
  const [protocolPreference, setProtocolPreference] = useState<'auto' | 'ws'>('ws');

  const busyRef = useRef(false);
  const orchRef = useRef<SessionOrchestrator | null>(null);
  const micRef = useRef<MicCaptureHandle | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const speechStartedAtRef = useRef<number | null>(null);
  const audioBySeqRef = useRef(new Map<number, SegmentAudio>());
  const meterRef = useRef(new UsageMeter());
  const sink = useMemo(() => createPlayerSink(), []);
  const playerRef = useRef<StreamPlayer | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const segmenterRef = useRef(
    new AudioSegmenter((responseId, pcm24k) => {
      const seg = orchRef.current?.model.getSegments().find((s) => s.responseId === responseId);
      if (!seg) return;
      audioBySeqRef.current.set(seg.seq, {
        wav: pcm16ToWav(pcm24k, OUTPUT_SAMPLE_RATE),
        durationSec: wavDurationSeconds(pcm24k.length, OUTPUT_SAMPLE_RATE),
      });
      force();
    }),
  );

  useEffect(() => {
    void createGatewayApi().getSettings().then((r) => {
      setHotwordTables(r.settings.hotwordTables);
      setSourceLanguage(r.settings.sourceLanguage || 'auto');
      setTargetLanguage(r.settings.targetLanguage || 'en');
      setProtocolPreference(r.settings.protocolPreference);
    });
  }, []);

  useEffect(() => {
    if (startedAt === null) return;
    const t = setInterval(force, 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  useEffect(() => () => {
    micRef.current?.stop();
    micRef.current = null;
    orchRef.current?.transport?.abort();
    orchRef.current = null;
    sink.stop();
    playerRef.current?.flush();
    void ctxRef.current?.close();
  }, [sink]);

  function buildConfig(): SessionConfig {
    const isHeadphone = tab === 'headphone';
    const table = hotwordTables.find((t) => t.name === hotwordTable);
    if (isHeadphone) {
      return {
        modalities: ['text', 'audio'],
        voice: 'default',
        enable_voice_clone: true,
        voice_clone_options: { frequency: 'once' as const },
        sample_rate: 16000,
        input_audio_format: 'pcm',
        input_audio_transcription: {
          model: 'qwen3-asr-flash-realtime',
          ...(sourceLanguage !== 'auto' ? { language: sourceLanguage } : {}),
        },
        translation: { language: targetLanguage, ...(table ? { corpus: { phrases: table.phrases } } : {}) },
      };
    }
    return {
      modalities: withAudio && supportsAudioOutput(targetLanguage) ? ['text', 'audio'] : ['text'],
      voice: 'Tina',
      sample_rate: 16000,
      input_audio_format: 'pcm',
      input_audio_transcription: {
        model: 'qwen3-asr-flash-realtime',
        ...(sourceLanguage !== 'auto' ? { language: sourceLanguage } : {}),
      },
      translation: { language: targetLanguage, ...(table ? { corpus: { phrases: table.phrases } } : {}) },
    };
  }

  function persistDoneSegment(responseId: string): void {
    const sessionId = sessionIdRef.current;
    const seg = orchRef.current?.model.getSegments().find((s) => s.responseId === responseId);
    if (!sessionId || !seg) return;
    const audio = audioBySeqRef.current.get(seg.seq);
    void postSegmentRecord({
      sessionId, seq: seg.seq, vadStartMs: seg.vadStartMs, vadEndMs: seg.vadEndMs,
      sourceText: seg.sourceText, targetText: seg.targetText,
      sourceLang: seg.sourceLang, emotion: seg.emotion,
      usageJson: seg.usage ? JSON.stringify(seg.usage) : null,
      ...(audio ? { wavBase64: bytesToBase64(audio.wav) } : {}),
    });
  }

  function handleEvent(ev: NormalizedEvent): void {
    if (ev.kind === 'session-created') {
      sessionIdRef.current = ev.sessionId;
      void createSessionRecord({ id: ev.sessionId, mode: tab === 'headphone' ? 'interpreter' : 'solo', configJson: JSON.stringify(buildConfig()), startedAt: Date.now() });
    }
    if (ev.kind === 'speech-started') speechStartedAtRef.current = Date.now();
    if (ev.kind === 'translation-delta' && speechStartedAtRef.current !== null) {
      setFirstDeltaLatencyMs(Date.now() - speechStartedAtRef.current);
      speechStartedAtRef.current = null;
    }
    if (tab === 'headphone' && ev.kind === 'audio-delta') playerRef.current?.enqueuePcm(base64ToBytes(ev.base64));
    segmenterRef.current.apply(ev);
    if (ev.kind === 'response-done') {
      if (ev.usage) {
        setUsage(meterRef.current.applyUsage(ev.usage));
      }
      persistDoneSegment(ev.responseId);
    }
  }

  async function start(): Promise<void> {
    if (busyRef.current || orchRef.current) return;
    if (tab === 'headphone' && !choice) { setShowWizard(true); return; }
    busyRef.current = true;
    setStarting(true);

    function makeTransport(): ITranslateTransport {
      const makeWs = () => new WsTransport({ url: getPlatform().gatewayWsUrl(), wsFactory: browserWsFactory });
      if (tab === 'text' || protocolPreference !== 'auto') return makeWs();
      return new AutoTransport({
        makeWs,
        makeWebRtc: () => new WebRtcTransport({
          peerFactory: browserPeerFactory,
          sdpExchange: exchangeSdp,
          getLocalStream: () => navigator.mediaDevices.getUserMedia({
            audio: { deviceId: choice ? { exact: choice.inputDeviceId } : undefined, echoCancellation: true, noiseSuppression: true },
          }),
        }),
        onChannelChosen: (_kind, reason) => {
          setChannelNotice(reason === 'fallback' ? 'WebRTC 不可用，已自动降级为 WS 通道' : null);
        },
      });
    }

    const orch = new SessionOrchestrator({
      config: buildConfig(),
      transportFactory: makeTransport,
      onStateChange: setState,
      onEvent: handleEvent,
    });
    orch.model.onChange(() => { force(); setSegments(orch.model.getSegments()); });
    orchRef.current = orch;
    meterRef.current = new UsageMeter();
    audioBySeqRef.current = new Map();
    segmenterRef.current.reset();
    setUsage(null);
    setFirstDeltaLatencyMs(null);
    setChannelNotice(null);

    try {
      if (tab === 'headphone' && choice) {
        const ctx = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
        const sinkable = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
        if (sinkable.setSinkId) await sinkable.setSinkId(choice.outputDeviceId);
        ctxRef.current = ctx;
        playerRef.current = new StreamPlayer(ctx);
      }
      await orch.start();
      if (tab === 'headphone') {
        const remote = orch.transport?.getRemoteAudio();
        if (remote) {
          const el = new Audio();
          el.srcObject = remote;
          const sinkEl = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
          if (sinkEl.setSinkId && choice) await sinkEl.setSinkId(choice.outputDeviceId);
          await el.play();
          remoteAudioRef.current = el;
        }
      }
      setStartedAt(Date.now());
      micRef.current = await startMicCapture({
        deviceId: tab === 'headphone' && choice ? choice.inputDeviceId : undefined,
        echoCancellation: tab === 'headphone',
        onChunk: (b) => orch.pushAudio(b),
      });
    } catch (err) {
      micRef.current?.stop(); micRef.current = null;
      orch.transport?.abort(); orchRef.current = null;
      playerRef.current = null;
      void ctxRef.current?.close(); ctxRef.current = null;
      setState('idle');
      console.error('[live] start failed:', err);
    } finally {
      setStarting(false);
      busyRef.current = false;
    }
  }

  function pause(): void {
    micRef.current?.pause();
    orchRef.current?.pause();
    playerRef.current?.flush();
    if (remoteAudioRef.current) remoteAudioRef.current.muted = true;
  }

  function resume(): void {
    micRef.current?.resume();
    orchRef.current?.resume();
    if (remoteAudioRef.current) remoteAudioRef.current.muted = false;
  }

  async function reset(): Promise<void> {
    audioBySeqRef.current = new Map();
    segmenterRef.current.reset();
    meterRef.current.startNewSession();
    setUsage(meterRef.current.snapshot());
    setFirstDeltaLatencyMs(null);
    await orchRef.current?.reset();
    setStartedAt(Date.now());
  }

  async function stop(): Promise<void> {
    micRef.current?.stop(); micRef.current = null;
    await orchRef.current?.stop();
    orchRef.current = null;
    remoteAudioRef.current?.pause(); remoteAudioRef.current = null;
    playerRef.current?.flush(); playerRef.current = null;
    void ctxRef.current?.close(); ctxRef.current = null;
    setChannelNotice(null);
    const sessionId = sessionIdRef.current;
    if (sessionId) {
      await finishSessionRecord({ id: sessionId, endedAt: Date.now(), usageJson: JSON.stringify(meterRef.current.snapshot().sessionTotal) });
    }
    sessionIdRef.current = null;
    setStartedAt(null);
  }

  function switchTab(t: Tab): void {
    setSearchParams({ tab: t });
  }

  const modelSegments = orchRef.current?.model.getSegments() ?? [];
  const running = state === 'running' || state === 'paused' || state === 'reconnecting';
  const sessionSeconds = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  const fmtTime = `${String(Math.floor(sessionSeconds / 60)).padStart(2, '0')}:${String(sessionSeconds % 60).padStart(2, '0')}`;

  // Headphone mode: show wizard or subtitle overlay when running
  if (starting) {
    return (
      <div className="connecting-overlay">
        <div className="connecting-spinner" />
        <div className="connecting-text">正在建立连接…</div>
        <div className="connecting-sub">正在与 LiveTranslate 服务建立 WebSocket 会话，请稍候</div>
      </div>
    );
  }

  if (tab === 'headphone' && showWizard && !choice) {
    return <ChannelWizard onComplete={(c) => { setChoice(c); setShowWizard(false); }} />;
  }

  if (tab === 'headphone' && running) {
    return (
      <SubtitleOverlay
        segments={segments}
        channelKind={orchRef.current?.transport?.kind ?? 'ws'}
        latencyMs={firstDeltaLatencyMs}
        paused={state === 'paused'}
        onPause={pause}
        onResume={resume}
        onEnd={() => void stop()}
      />
    );
  }

  return (
    <div className="page-content" style={{ maxWidth: 'var(--content-max)' }}>
      <div className="live-header">
        <div className="page-header" style={{ marginBottom: 0 }}>
          <h1 className="page-title">实时翻译</h1>
        </div>
        <div className="tabs">
          <button className={`tab-item${tab === 'text' ? ' active' : ''}`} onClick={() => switchTab('text')}>文本模式</button>
          <button className={`tab-item${tab === 'headphone' ? ' active' : ''}`} onClick={() => switchTab('headphone')}>耳机模式</button>
        </div>
      </div>

      {/* Config bar */}
      <div className="config-bar">
        <div className="config-chips" role="group" aria-label="配置">
          <button className="config-chip" onClick={() => !running && setConfigOpen(!configOpen)} aria-expanded={configOpen} aria-label="语言设置">
            {sourceLanguage === 'auto' ? '自动检测' : LANGUAGES.find((l) => l.code === sourceLanguage)?.name ?? sourceLanguage}
            {' → '}
            {LANGUAGES.find((l) => l.code === targetLanguage)?.name ?? targetLanguage}
            <ChevronDown size={12} />
          </button>
          <span className="config-chip" aria-label={`语音：${tab === 'headphone' || withAudio ? '开' : '关'}`}>语音：{tab === 'headphone' ? '开' : withAudio ? '开' : '关'}</span>
          {hotwordTable && <span className="config-chip">热词：{hotwordTable}</span>}
        </div>
        <div className={`config-panel card${configOpen ? ' open' : ''}`}>
          <div className="config-grid">
            <div>
              <label className="label">源语言</label>
              <select className="select" value={sourceLanguage} onChange={(e) => setSourceLanguage(e.target.value)} disabled={running}>
                <option value="auto">自动检测</option>
                {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">目标语言</label>
              <select className="select" value={targetLanguage} disabled={running}
                onChange={(e) => { setTargetLanguage(e.target.value); if (!supportsAudioOutput(e.target.value)) setWithAudio(false); }}>
                {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
              </select>
            </div>
          </div>
          <div style={{ marginTop: 'var(--space-4)' }}>
            {tab === 'text' && (
              <div className="config-row">
                <span className="config-row-label">同时生成语音</span>
                <button className={`switch${withAudio ? ' on' : ''}${running || !supportsAudioOutput(targetLanguage) ? ' disabled' : ''}`}
                  role="switch" aria-checked={withAudio} aria-label="同时生成语音"
                  onClick={() => { if (!running && supportsAudioOutput(targetLanguage)) setWithAudio(!withAudio); }} />
              </div>
            )}
            <div className="config-row">
              <span className="config-row-label">热词表</span>
              <select className="select" style={{ width: '160px' }} value={hotwordTable} onChange={(e) => setHotwordTable(e.target.value)} disabled={running}>
                <option value="">不使用</option>
                {hotwordTables.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
              </select>
            </div>
          </div>
          {running && <p style={{ fontSize: '12px', color: 'var(--color-text-tertiary)', marginTop: 'var(--space-3)' }}>会话进行中，配置已锁定</p>}
        </div>
      </div>

      {channelNotice && <div className="inline-alert warning">{channelNotice}</div>}
      {state === 'reconnecting' && <div className="toast-bar warning">连接中断，正在重连……</div>}
      {state === 'error' && <div className="inline-alert error">重连失败，请检查网络后重新开始</div>}

      {/* Transcript area */}
      <div className="transcript-area">
        {modelSegments.length === 0 && !running && (
          <div className="empty-state">
            <div className="empty-icon"><Mic size={24} /></div>
            <div className="empty-title">点击下方按钮，对着麦克风开始说话</div>
            <div className="empty-desc">翻译结果将实时显示在这里</div>
          </div>
        )}
        {modelSegments.map((seg) => {
          const audio = audioBySeqRef.current.get(seg.seq);
          const isStreaming = seg.status === 'listening' || seg.status === 'translating';
          const isExpanded = expandedSeq === seg.seq;
          return (
            <div key={seg.seq} className={`segment-card${isStreaming ? ' status-streaming' : ' status-done'}${isExpanded ? ' expanded' : ''}`}>
              <div className="segment-target">
                {seg.targetText}
                {seg.targetStash && <span className="stash">{seg.targetStash}</span>}
              </div>
              <div className="segment-source">
                {seg.sourceText}{seg.sourceStash ?? ''}
                {seg.sourceLang && <span className="emotion-badge">{seg.sourceLang}{seg.emotion ? ` · ${seg.emotion}` : ''}</span>}
              </div>
              <div className="segment-meta">
                {seg.vadStartMs != null && <span className="segment-time">{formatMs(seg.vadStartMs)}</span>}
                {audio && <button className="segment-replay" onClick={() => void sink.play(audio.wav)}><Play size={12} />回放</button>}
                <button className="segment-expand" onClick={() => setExpandedSeq(isExpanded ? null : seg.seq)}>
                  {isExpanded ? '收起原文' : '查看原文'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Control dock */}
      <div className="control-dock">
        <div className="dock-side">
          {running && (
            <button className="dock-icon-btn" title={state === 'paused' ? '恢复' : '暂停'}
              onClick={() => state === 'paused' ? resume() : pause()}>
              {state === 'paused' ? <Play size={16} /> : <Pause size={16} />}
            </button>
          )}
        </div>
        <button className={`mic-btn${running ? ' recording' : ''}`} disabled={starting}
          onClick={() => running ? void stop() : void start()}
          title={running ? '停止' : '开始'}>
          {running ? <Square size={22} /> : <Mic size={22} />}
        </button>
        <div className="dock-side right">
          {running && (
            <button className="dock-icon-btn" title="重置" onClick={() => void reset()}>
              <RotateCcw size={16} />
            </button>
          )}
          <div className="perf-badges">
            {firstDeltaLatencyMs !== null && (
              <span className="perf-badge"><span className="dot" />{(firstDeltaLatencyMs / 1000).toFixed(1)}s 响应</span>
            )}
            {startedAt && <span className="perf-badge">{fmtTime}</span>}
          </div>
        </div>
      </div>

      {/* Headphone mode: reconfigure button */}
      {tab === 'headphone' && choice && !running && (
        <p style={{ textAlign: 'center', fontSize: '13px', color: 'var(--color-text-tertiary)' }}>
          收音：{choice.inputDeviceId.slice(0, 8)}… ｜ 播音：{choice.outputDeviceId.slice(0, 8)}…
          {' '}<button className="btn btn-ghost btn-sm" onClick={() => { setChoice(null); setShowWizard(true); }}>重新配置声道</button>
        </p>
      )}
      {tab === 'headphone' && !supportsAudioOutput(targetLanguage) && !running && (
        <div className="inline-alert error">该目标语言仅支持文本输出，无法启动耳机模式，请改选支持语音的语言。</div>
      )}
    </div>
  );
}

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
