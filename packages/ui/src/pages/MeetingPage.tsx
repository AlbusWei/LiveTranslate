import { useRef, useState } from 'react';
import {
  AudioSegmenter, LANGUAGES, MeetingCoordinator, OUTPUT_SAMPLE_RATE, SessionOrchestrator, UsageMeter, WsTransport,
  base64ToBytes, buildMeetingMarkdown, buildMeetingTxt, shouldRotate, supportsAudioOutput,
  type HotSeatState, type NormalizedEvent, type OrchestratorState, type SessionConfig, type TranscriptSegment,
  type UsageSnapshot,
} from '@livetranslate/core';
import { getPlatform } from '../platform';
import { browserWsFactory } from '../wsFactory';
import {
  createMeetingRecord, createSessionRecord, fetchMeetingTurns, finishSessionRecord, postMeetingTurn, postSegmentRecord,
} from '../api';
import { startMicCapture, type MicCaptureHandle } from '../audio/micCapture';
import { StreamPlayer } from '../audio/streamPlayer';

// 时间线卡片：发言记录跨 session 轮换累积（model 轮换会清零，故独立保存）
interface TimelineTurn {
  key: string;
  speaker: string;
  sourceText: string;
  targetText: string;
  sourceLang: string | null;
  doneAt: number;
  pcm24k: Uint8Array | null; // ▶重播用（内存内，不落库）
}

export function MeetingPage(): JSX.Element {
  const [rosterText, setRosterText] = useState('');
  const [targetLanguage, setTargetLanguage] = useState('en');
  const [running, setRunning] = useState(false);
  const [hotSeat, setHotSeat] = useState<HotSeatState>('idle');
  const [speaker, setSpeaker] = useState<string | null>(null);
  const [rotationNotice, setRotationNotice] = useState<string | null>(null);
  const [connState, setConnState] = useState<OrchestratorState>('idle');
  const [segments, setSegments] = useState<readonly TranscriptSegment[]>([]);
  const [timeline, setTimeline] = useState<TimelineTurn[]>([]);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [lastMeetingId, setLastMeetingId] = useState<string | null>(null);

  const coordRef = useRef<MeetingCoordinator | null>(null);
  const orchRef = useRef<SessionOrchestrator | null>(null);
  const micRef = useRef<MicCaptureHandle | null>(null);
  const playerRef = useRef<StreamPlayer | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const meterRef = useRef(new UsageMeter());
  const sessionIdRef = useRef<string | null>(null);
  const meetingIdRef = useRef<string | null>(null);
  const rosterRef = useRef<string[]>([]);
  const createdAtRef = useRef(0);
  const idleSinceRef = useRef(Date.now());
  const pollRef = useRef<number | null>(null);
  const pcmByResponseRef = useRef(new Map<string, Uint8Array>());
  const segmenterRef = useRef(
    new AudioSegmenter((responseId, pcm24k) => pcmByResponseRef.current.set(responseId, pcm24k)),
  );

  const roster = rosterText.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);

  function buildConfig(): SessionConfig {
    return {
      modalities: ['text', 'audio'],
      voice: 'default', // P10：复刻时 voice 必须 "default"
      enable_voice_clone: true,
      voice_clone_options: { frequency: 'always' as const }, // spec §5.4：每位发言人实时复刻
      sample_rate: 16000,
      input_audio_format: 'pcm',
      input_audio_transcription: { model: 'qwen3-asr-flash-realtime' }, // 多人多语种：语种自动检测（P5）
      translation: { language: targetLanguage }, // 全场统一目标语言
    };
  }

  function waitPlaybackEnd(): void {
    if (pollRef.current !== null) return;
    pollRef.current = window.setInterval(() => {
      const player = playerRef.current;
      if (!player || player.bufferedSeconds() > 0) return;
      window.clearInterval(pollRef.current!);
      pollRef.current = null;
      coordRef.current?.notePlaybackFinished(); // 播完释放热座
    }, 200);
  }

  function persistTurn(responseId: string): void {
    const sessionId = sessionIdRef.current;
    const mId = meetingIdRef.current;
    const seg = orchRef.current?.model.getSegments().find((s) => s.responseId === responseId);
    const who = coordRef.current?.speaker;
    if (!sessionId || !mId || !seg || !who) return;
    // 时间线卡片：立即入本地时间线（重播音频取自 AudioSegmenter 拼好的 24k PCM）
    setTimeline((prev) => [...prev, {
      key: `${sessionId}:${seg.seq}`, speaker: who,
      sourceText: seg.sourceText, targetText: seg.targetText, sourceLang: seg.sourceLang,
      doneAt: Date.now(), pcm24k: pcmByResponseRef.current.get(responseId) ?? null,
    }]);
    void postSegmentRecord({
      sessionId, seq: seg.seq, vadStartMs: seg.vadStartMs, vadEndMs: seg.vadEndMs,
      sourceText: seg.sourceText, targetText: seg.targetText,
      sourceLang: seg.sourceLang, emotion: seg.emotion,
      usageJson: seg.usage ? JSON.stringify(seg.usage) : null,
    }).then(() => postMeetingTurn({ meetingId: mId, speaker: who, sessionId, seq: seg.seq })); // 先落 segment 再记 turn（JOIN 依赖）
  }

  function handleEvent(ev: NormalizedEvent): void {
    const coord = coordRef.current;
    if (!coord) return;
    if (ev.kind === 'session-created') {
      sessionIdRef.current = ev.sessionId;
      void createSessionRecord({ id: ev.sessionId, mode: 'meeting', configJson: JSON.stringify(buildConfig()), startedAt: Date.now() });
    }
    if (ev.kind === 'speech-started') coord.noteSpeechStarted();
    if (ev.kind === 'speech-stopped') coord.noteSpeechStopped(); // 3s 静音后自动结束发言（T30）
    segmenterRef.current.apply(ev); // ▶重播：按 responseId 拼接完整段音频
    if (ev.kind === 'audio-delta') {
      coord.notePlaybackStarted(); // translating→playing（其余状态忽略，幂等）
      playerRef.current?.enqueuePcm(base64ToBytes(ev.base64)); // T27 边收边播
      waitPlaybackEnd();
    }
    if (ev.kind === 'server-error') void rotateSession('error'); // spec §5.4：异常即轮换
    if (ev.kind === 'response-done') {
      if (ev.usage) setUsage(meterRef.current.applyUsage(ev.usage)); // P6 差分
      persistTurn(ev.responseId);
      const reason = shouldRotate({
        sessionInputTokens: meterRef.current.snapshot().sessionTotal.input_tokens,
        hadError: false, pausedSinceMs: null, now: Date.now(),
      });
      if (reason) void rotateSession(reason); // P13：token 超限轮换
    }
  }

  async function startOrchestrator(): Promise<void> {
    const orch = new SessionOrchestrator({
      config: buildConfig(),
      transportFactory: () => new WsTransport({ url: getPlatform().gatewayWsUrl(), wsFactory: browserWsFactory }), // D1：会议固定 WS
      onStateChange: setConnState,
      onEvent: handleEvent,
    });
    orch.model.onChange(() => setSegments(orch.model.getSegments()));
    orchRef.current = orch;
    await orch.start();
  }

  async function rotateSession(reason: string): Promise<void> {
    const oldId = sessionIdRef.current;
    await orchRef.current?.stop(); // P3：finish→finished→close，旧日志自然封口
    if (oldId) {
      await finishSessionRecord({ id: oldId, endedAt: Date.now(), usageJson: JSON.stringify(meterRef.current.snapshot().sessionTotal) });
    }
    sessionIdRef.current = null;
    meterRef.current.startNewSession(); // session 累积归零，全局累计保留
    await startOrchestrator();
    setRotationNotice(`会话已轮换（${reason}），会议不中断，字幕从新 session 重新计段`);
  }

  async function startMeeting(): Promise<void> {
    const id = `meet_${Date.now()}`;
    const createdAt = Date.now();
    await createMeetingRecord({ id, roster, targetLanguage, createdAt });
    meetingIdRef.current = id;
    rosterRef.current = roster;
    createdAtRef.current = createdAt;
    setLastMeetingId(id);
    coordRef.current = new MeetingCoordinator({
      schedule: (cb, delayMs) => {
        const t = window.setTimeout(cb, delayMs);
        return () => window.clearTimeout(t);
      },
      onStateChange: (s, who) => {
        setHotSeat(s);
        setSpeaker(who);
        if (s === 'idle') idleSinceRef.current = Date.now(); // 空座起计时，供长时间空闲轮换判定
      },
    });
    const ctx = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE }); // P9
    ctxRef.current = ctx;
    playerRef.current = new StreamPlayer(ctx);
    meterRef.current = new UsageMeter();
    pcmByResponseRef.current = new Map();
    segmenterRef.current.reset();
    setTimeline([]);
    setUsage(null);
    setRotationNotice(null);
    await startOrchestrator();
    micRef.current = await startMicCapture({
      echoCancellation: true, // D6
      onChunk: (b) => {
        if (coordRef.current?.state === 'speaking') orchRef.current?.pushAudio(b); // 仅热座持有人推流
      },
    });
    setRunning(true);
  }

  // 手动结束发言：热座转 translating 后麦克风停止推流，服务端 VAD 收不到静音帧将无法闭合当前段
  // （卡在 translating 无 response）。补送 3.5s 静音尾巴驱动 VAD 闭合（P7：100ms/块）。
  function endSpeechManually(): void {
    coordRef.current?.endSpeech();
    for (let i = 0; i < 35; i++) orchRef.current?.pushAudio(new ArrayBuffer(3200));
  }

  async function grabSeat(name: string): Promise<void> {
    // 抢座前检查：长时间无人发言按“暂停”处理（spec §5.4 暂停超 10 分钟轮换）
    const reason = shouldRotate({
      sessionInputTokens: meterRef.current.snapshot().sessionTotal.input_tokens,
      hadError: false,
      pausedSinceMs: hotSeat === 'idle' ? idleSinceRef.current : null,
      now: Date.now(),
    });
    if (reason) await rotateSession(reason);
    coordRef.current?.requestSpeak(name); // 非 idle 时返回 false，按钮本身也已禁用
  }

  async function endMeeting(): Promise<void> {
    micRef.current?.stop();
    micRef.current = null;
    await orchRef.current?.stop();
    const sessionId = sessionIdRef.current;
    if (sessionId) {
      await finishSessionRecord({ id: sessionId, endedAt: Date.now(), usageJson: JSON.stringify(meterRef.current.snapshot().sessionTotal) });
    }
    sessionIdRef.current = null;
    playerRef.current?.flush();
    playerRef.current = null;
    void ctxRef.current?.close();
    ctxRef.current = null;
    if (pollRef.current !== null) { window.clearInterval(pollRef.current); pollRef.current = null; }
    setRunning(false);
    setHotSeat('idle');
    setSpeaker(null);
  }

  // ▶重播：会中/会后都可用；会后 ctx 已关，按需重建播放上下文
  function replayTurn(t: TimelineTurn): void {
    if (!t.pcm24k) return;
    let ctx = ctxRef.current;
    if (!ctx || ctx.state === 'closed') {
      ctx = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
      ctxRef.current = ctx;
      playerRef.current = null;
    }
    new StreamPlayer(ctx).enqueuePcm(t.pcm24k);
  }

  async function exportMeeting(kind: 'md' | 'txt'): Promise<void> {
    const mId = lastMeetingId;
    if (!mId) return;
    const turns = (await fetchMeetingTurns(mId)).map((t) => ({
      speaker: t.speaker, sourceText: t.source_text, targetText: t.target_text, sourceLang: t.source_lang,
    }));
    const content = kind === 'md'
      ? buildMeetingMarkdown({ roster: rosterRef.current, targetLanguage, createdAtIso: new Date(createdAtRef.current).toISOString() }, turns)
      : buildMeetingTxt(turns);
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${mId}.${kind === 'md' ? 'md' : 'txt'}`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const fmtTime = (ms: number): string => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });

  const timelineCards = (
    <section className="segments meeting-timeline">
      {timeline.map((t) => (
        <div key={t.key} className="segment-card meeting-turn">
          <p className="turn-meta">
            <strong>{t.speaker}</strong>
            {t.sourceLang && <span className="turn-lang">（{t.sourceLang}）</span>}
            <span className="turn-time">{fmtTime(t.doneAt)}</span>
            <button disabled={!t.pcm24k} onClick={() => replayTurn(t)}>▶ 重播</button>
          </p>
          <p>{t.sourceText}</p>
          <p className="turn-target">{t.targetText}</p>
        </div>
      ))}
    </section>
  );

  if (!running) {
    const audioOk = supportsAudioOutput(targetLanguage);
    return (
      <div className="page-body">
        <h2>会议</h2>
        <label>参会人（逗号或换行分隔）
          <textarea value={rosterText} onChange={(e) => setRosterText(e.target.value)} rows={3} placeholder="Alice, Bob" />
        </label>
        <label>全场目标语言
          <select value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value)}>
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
        </label>
        {!audioOk && <p className="error-text">该目标语言仅支持文本输出，会议模式需要语音播报，请改选支持语音的语言。</p>}
        <button disabled={roster.length < 2 || !audioOk} onClick={() => void startMeeting()}>开始会议</button>
        {lastMeetingId && (
          <p>
            上一场会议：{lastMeetingId}
            <button onClick={() => void exportMeeting('md')}>导出 Markdown</button>
            <button onClick={() => void exportMeeting('txt')}>导出 TXT</button>
          </p>
        )}
        {timeline.length > 0 && timelineCards}
      </div>
    );
  }

  // 进行中的段落：speaking/translating 时流式预览（时间线卡片 done 后追加）
  const live = segments[segments.length - 1];
  const showLive = hotSeat !== 'idle' && live && live.status !== 'done';

  return (
    <div className="page-body meeting-page">
      <header className="meeting-topbar">
        <span className="channel-badge">WS</span>
        <span className={`hotseat-banner hotseat-${hotSeat}`}>
          {hotSeat === 'idle' && '空座，可抓占发言'}
          {hotSeat === 'speaking' && `${speaker} 正在发言…`}
          {hotSeat === 'translating' && `翻译 ${speaker} 的发言…`}
          {hotSeat === 'playing' && `播放 ${speaker} 的译文…`}
        </span>
        {connState === 'reconnecting' && <span className="warn-banner">连接中断，正在重连……</span>}
        <button onClick={() => void endMeeting()}>结束会议</button>
      </header>
      {rotationNotice && <p className="hint">{rotationNotice}</p>}
      <section className="meeting-seats">
        {rosterRef.current.map((name) => (
          <button key={name} className="seat-btn" disabled={hotSeat !== 'idle'} onClick={() => void grabSeat(name)}>
            {name} 发言
          </button>
        ))}
        {hotSeat === 'speaking' && <button onClick={endSpeechManually}>结束发言</button>}
        {hotSeat === 'playing' && (
          <button onClick={() => {
            playerRef.current?.flush(); // 丢弃剩余音频
            coordRef.current?.skipPlayback(); // spec §5.4：跳过播放
          }}>跳过播放</button>
        )}
      </section>
      <section className="usage-dashboard meeting-usage">
        <div className="metric"><span className="metric-label">会话 tokens</span><span className="metric-value">{(usage?.sessionTotal.total_tokens ?? 0).toLocaleString('en-US')}</span></div>
        <div className="metric"><span className="metric-label">输入 tokens</span><span className="metric-value">{(usage?.sessionTotal.input_tokens ?? 0).toLocaleString('en-US')}</span></div>
        <div className="metric"><span className="metric-label">最近段增量</span><span className="metric-value">+{(usage?.lastDelta.total_tokens ?? 0).toLocaleString('en-US')}</span></div>
        <div className="metric"><span className="metric-label">全局累计（含轮换）</span><span className="metric-value">{(usage?.globalTotal.total_tokens ?? 0).toLocaleString('en-US')}</span></div>
      </section>
      {timelineCards}
      {showLive && (
        <section className="segments">
          <div className="segment-card meeting-live">
            <p className="turn-meta"><strong>{speaker}</strong><span className="turn-time">进行中…</span></p>
            <p>{live.sourceText}{live.sourceStash && <span className="stash">{live.sourceStash}</span>}</p>
            <p className="turn-target">{live.targetText}{live.targetStash && <span className="stash">{live.targetStash}</span>}</p>
          </div>
        </section>
      )}
    </div>
  );
}
