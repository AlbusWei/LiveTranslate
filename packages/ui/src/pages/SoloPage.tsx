import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  AudioSegmenter, LANGUAGES, OUTPUT_SAMPLE_RATE, SessionOrchestrator, UsageMeter, WsTransport,
  bytesToBase64, pcm16ToWav, supportsAudioOutput, wavDurationSeconds,
  type NormalizedEvent, type OrchestratorState, type SessionConfig, type UsageSnapshot,
} from '@livetranslate/core';
import { getPlatform } from '../platform';
import { browserWsFactory } from '../wsFactory';
import { createGatewayApi, createSessionRecord, finishSessionRecord, postSegmentRecord, type AppSettingsDto } from '../api';
import { createPlayerSink } from '../audio/playerSink';
import { startMicCapture, type MicCaptureHandle } from '../audio/micCapture';
import { SegmentCard } from '../components/SegmentCard';
import { UsageDashboard } from '../components/UsageDashboard';

interface SegmentAudio {
  wav: Uint8Array;
  durationSec: number;
}

export function SoloPage(): JSX.Element {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const [state, setState] = useState<OrchestratorState>('idle');
  const [starting, setStarting] = useState(false);
  const [sourceLanguage, setSourceLanguage] = useState('auto');
  const [targetLanguage, setTargetLanguage] = useState('en');
  const [withAudio, setWithAudio] = useState(false); // 默认关（spec §5.1）
  const [hotwordTable, setHotwordTable] = useState('');
  const [hotwordTables, setHotwordTables] = useState<AppSettingsDto['hotwordTables']>([]);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [firstDeltaLatencyMs, setFirstDeltaLatencyMs] = useState<number | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  const busyRef = useRef(false); // 同步守卫：连点开始时 state 尚未 flush，防双建会话
  const orchRef = useRef<SessionOrchestrator | null>(null);
  const micRef = useRef<MicCaptureHandle | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const speechStartedAtRef = useRef<number | null>(null);
  const audioBySeqRef = useRef(new Map<number, SegmentAudio>());
  const meterRef = useRef(new UsageMeter());
  const sink = useMemo(() => createPlayerSink(), []);
  const segmenterRef = useRef(
    new AudioSegmenter((responseId, pcm24k) => {
      const seg = orchRef.current?.model.getSegments().find((s) => s.responseId === responseId);
      if (!seg) return;
      audioBySeqRef.current.set(seg.seq, {
        wav: pcm16ToWav(pcm24k, OUTPUT_SAMPLE_RATE), // P9：输出 24kHz
        durationSec: wavDurationSeconds(pcm24k.length, OUTPUT_SAMPLE_RATE),
      });
      force();
    }),
  );

  useEffect(() => {
    void createGatewayApi().getSettings().then((r) => setHotwordTables(r.settings.hotwordTables));
  }, []);

  useEffect(() => {
    if (startedAt === null) return;
    const t = setInterval(force, 1000); // 会话时长计时
    return () => clearInterval(t);
  }, [startedAt]);

  // 卸载清理：路由切走时停止采集、断开连接，不留后台泄漏
  useEffect(() => () => {
    micRef.current?.stop();
    micRef.current = null;
    orchRef.current?.transport?.abort();
    orchRef.current = null;
    sink.stop();
  }, [sink]);

  function buildConfig(): SessionConfig {
    const table = hotwordTables.find((t) => t.name === hotwordTable);
    return {
      modalities: withAudio && supportsAudioOutput(targetLanguage) ? ['text', 'audio'] : ['text'],
      voice: 'Tina',
      sample_rate: 16000,
      input_audio_format: 'pcm',
      input_audio_transcription: {
        model: 'qwen3-asr-flash-realtime',
        ...(sourceLanguage !== 'auto' ? { language: sourceLanguage } : {}),
      },
      translation: {
        language: targetLanguage,
        ...(table ? { corpus: { phrases: table.phrases } } : {}), // P12 热词
      },
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
      sessionIdRef.current = ev.sessionId; // 用服务端 session id，与 relay 日志文件同键
      void createSessionRecord({ id: ev.sessionId, mode: 'solo', configJson: JSON.stringify(buildConfig()), startedAt: Date.now() });
    }
    if (ev.kind === 'speech-started') speechStartedAtRef.current = Date.now();
    if (ev.kind === 'translation-delta' && speechStartedAtRef.current !== null) {
      setFirstDeltaLatencyMs(Date.now() - speechStartedAtRef.current); // 当前段首字延迟
      speechStartedAtRef.current = null;
    }
    segmenterRef.current.apply(ev);
    if (ev.kind === 'response-done' && ev.usage) {
      setUsage(meterRef.current.applyUsage(ev.usage)); // P6 差分
      persistDoneSegment(ev.responseId); // R2：done 即结算落库
    }
  }

  async function start(): Promise<void> {
    if (busyRef.current || orchRef.current) return; // 防重入
    busyRef.current = true;
    setStarting(true);
    const orch = new SessionOrchestrator({
      config: buildConfig(),
      transportFactory: () => new WsTransport({ url: getPlatform().gatewayWsUrl(), wsFactory: browserWsFactory }),
      onStateChange: setState,
      onEvent: handleEvent,
    });
    orch.model.onChange(force);
    orchRef.current = orch;
    meterRef.current = new UsageMeter();
    audioBySeqRef.current = new Map();
    segmenterRef.current.reset();
    setUsage(null);
    setFirstDeltaLatencyMs(null);
    try {
      await orch.start();
      setStartedAt(Date.now());
      micRef.current = await startMicCapture({ onChunk: (b) => orch.pushAudio(b) });
    } catch (err) {
      micRef.current?.stop();
      micRef.current = null;
      orch.transport?.abort();
      orchRef.current = null;
      setState('idle');
      console.error('[solo] start failed:', err);
    } finally {
      setStarting(false);
      busyRef.current = false;
    }
  }

  function pause(): void {
    micRef.current?.pause();
    orchRef.current?.pause(); // R4：保连接停推流
  }

  function resume(): void {
    micRef.current?.resume();
    orchRef.current?.resume();
  }

  async function reset(): Promise<void> {
    audioBySeqRef.current = new Map();
    segmenterRef.current.reset(); // 丢弃 abort 掉的 response 残留音频缓冲
    meterRef.current.startNewSession(); // 新 session 累积从零，全局累计保留
    setUsage(meterRef.current.snapshot());
    setFirstDeltaLatencyMs(null);
    await orchRef.current?.reset(); // R4：历史已落库不删除
    setStartedAt(Date.now());
  }

  async function stop(): Promise<void> {
    micRef.current?.stop();
    micRef.current = null;
    await orchRef.current?.stop(); // P3：finish → finished → 客户端 close
    orchRef.current = null;
    const sessionId = sessionIdRef.current;
    if (sessionId) {
      await finishSessionRecord({ id: sessionId, endedAt: Date.now(), usageJson: JSON.stringify(meterRef.current.snapshot().sessionTotal) });
    }
    sessionIdRef.current = null;
    setStartedAt(null);
  }

  const segments = orchRef.current?.model.getSegments() ?? [];
  const running = state === 'running' || state === 'paused' || state === 'reconnecting';
  return (
    <div className="solo-page">{/* App 外壳已提供 .page-body，不重复套 */}
      <section className="config-panel">
        <label>源语言
          <select value={sourceLanguage} onChange={(e) => setSourceLanguage(e.target.value)} disabled={running}>
            <option value="auto">自动检测</option>
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
        </label>
        <label>目标语言
          <select value={targetLanguage} disabled={running}
            onChange={(e) => { setTargetLanguage(e.target.value); if (!supportsAudioOutput(e.target.value)) setWithAudio(false); }}>
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={withAudio} disabled={running || !supportsAudioOutput(targetLanguage)}
            onChange={(e) => setWithAudio(e.target.checked)} />
          同时生成语音{!supportsAudioOutput(targetLanguage) && '（该目标语言仅支持文本）'}
        </label>
        <label>热词表
          <select value={hotwordTable} onChange={(e) => setHotwordTable(e.target.value)} disabled={running}>
            <option value="">不使用</option>
            {hotwordTables.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
          </select>
        </label>
      </section>
      <section className="controls">
        {!running && <button onClick={() => void start()} disabled={starting}>开始</button>}
        {state === 'running' && <button onClick={pause}>暂停</button>}
        {state === 'paused' && <button onClick={resume}>恢复</button>}
        {running && <button onClick={() => void reset()}>重置</button>}
        {running && <button onClick={() => void stop()}>结束</button>}
        {state === 'reconnecting' && <span className="warn-banner">连接中断，正在重连……</span>}
        {state === 'error' && <span className="warn-banner">重连失败，请检查网络后重新开始</span>}
      </section>
      <UsageDashboard snapshot={usage} firstDeltaLatencyMs={firstDeltaLatencyMs}
        sessionSeconds={startedAt ? (Date.now() - startedAt) / 1000 : 0} />
      <section className="segments">
        {segments.map((seg) => {
          const audio = audioBySeqRef.current.get(seg.seq);
          return (
            <SegmentCard key={seg.seq} segment={seg}
              audio={audio ? { durationSec: audio.durationSec, onPlay: () => void sink.play(audio.wav) } : null} />
          );
        })}
      </section>
    </div>
  );
}
