import { useRef, useState } from 'react';
import {
  AudioSegmenter, LANGUAGES, MeetingCoordinator, OUTPUT_SAMPLE_RATE, SessionOrchestrator, UsageMeter, WsTransport,
  base64ToBytes, buildMeetingMarkdown, buildMeetingTxt, shouldRotate, supportsAudioOutput,
  type HotSeatState, type NormalizedEvent, type OrchestratorState, type SessionConfig, type TranscriptSegment,
  type UsageSnapshot,
} from '@livetranslate/core';
import { Plus, Trash2, Play, Mic, Loader2 } from 'lucide-react';
import { getPlatform } from '../platform';
import { browserWsFactory } from '../wsFactory';
import {
  createMeetingRecord, createSessionRecord, fetchMeetingTurns, finishSessionRecord, postMeetingTurn, postSegmentRecord,
} from '../api';
import { startMicCapture, type MicCaptureHandle } from '../audio/micCapture';
import { StreamPlayer } from '../audio/streamPlayer';

const AVATAR_COLORS = ['#5B7FD4', '#D45B8A', '#4BAA7C', '#C4873B', '#7C5BD4', '#D45B5B', '#5BA8D4', '#8AAD3B'];

interface TimelineTurn {
  key: string;
  speaker: string;
  sourceText: string;
  targetText: string;
  sourceLang: string | null;
  doneAt: number;
  pcm24k: Uint8Array | null;
}

interface RosterEntry { name: string; lang: string; }

export function MeetingPage(): JSX.Element {
  const [rosterEntries, setRosterEntries] = useState<RosterEntry[]>([{ name: '', lang: 'auto' }, { name: '', lang: 'auto' }]);
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
  const [starting, setStarting] = useState(false);
  const playbackStartedRef = useRef(false);
  const segmenterRef = useRef(
    new AudioSegmenter((responseId, pcm24k) => pcmByResponseRef.current.set(responseId, pcm24k)),
  );

  const roster = rosterEntries.map((e) => e.name.trim()).filter(Boolean);

  function buildConfig(): SessionConfig {
    return {
      modalities: ['text', 'audio'],
      voice: 'default',
      enable_voice_clone: true,
      voice_clone_options: { frequency: 'always' as const },
      sample_rate: 16000,
      input_audio_format: 'pcm',
      input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
      translation: { language: targetLanguage },
    };
  }

  function waitPlaybackEnd(): void {
    if (pollRef.current !== null) return;
    playbackStartedRef.current = false;
    pollRef.current = window.setInterval(() => {
      const player = playerRef.current;
      if (!player) return;
      const buffered = player.bufferedSeconds();
      // 首次检测到有缓冲音频时标记播放已开始
      if (buffered > 0) playbackStartedRef.current = true;
      // 只有播放已启动且缓冲耗尽时才认为播放结束，防首次轮询误判
      if (playbackStartedRef.current && buffered <= 0) {
        window.clearInterval(pollRef.current!);
        pollRef.current = null;
        playbackStartedRef.current = false;
        coordRef.current?.notePlaybackFinished();
      }
    }, 200);
  }

  function persistTurn(responseId: string): void {
    const sessionId = sessionIdRef.current;
    const mId = meetingIdRef.current;
    const seg = orchRef.current?.model.getSegments().find((s) => s.responseId === responseId);
    const who = coordRef.current?.speaker;
    if (!sessionId || !mId || !seg || !who) return;
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
    }).then(() => postMeetingTurn({ meetingId: mId, speaker: who, sessionId, seq: seg.seq }));
  }

  function handleEvent(ev: NormalizedEvent): void {
    const coord = coordRef.current;
    if (!coord) return;
    if (ev.kind === 'session-created') {
      sessionIdRef.current = ev.sessionId;
      void createSessionRecord({ id: ev.sessionId, mode: 'meeting', configJson: JSON.stringify(buildConfig()), startedAt: Date.now() });
    }
    if (ev.kind === 'speech-started') coord.noteSpeechStarted();
    if (ev.kind === 'speech-stopped') coord.noteSpeechStopped();
    segmenterRef.current.apply(ev);
    if (ev.kind === 'audio-delta') {
      coord.notePlaybackStarted();
      playerRef.current?.enqueuePcm(base64ToBytes(ev.base64));
      waitPlaybackEnd();
    }
    if (ev.kind === 'server-error') void rotateSession('error');
    if (ev.kind === 'response-done') {
      // 翻译完成：若未进入 playing（无 audio-delta），直接释放热座并清除轮询
      // 若已在 playing（音频仍在播放），不清除轮询——让 waitPlaybackEnd 自然检测播放结束
      if (coord.state === 'translating') {
        coord.noteResponseDone();
        if (pollRef.current !== null) { window.clearInterval(pollRef.current); pollRef.current = null; }
      }
      if (ev.usage) setUsage(meterRef.current.applyUsage(ev.usage));
      persistTurn(ev.responseId);
      const reason = shouldRotate({ sessionInputTokens: meterRef.current.snapshot().sessionTotal.input_tokens, hadError: false, pausedSinceMs: null, now: Date.now() });
      if (reason) void rotateSession(reason);
    }
  }

  async function startOrchestrator(): Promise<void> {
    const orch = new SessionOrchestrator({
      config: buildConfig(),
      transportFactory: () => new WsTransport({ url: getPlatform().gatewayWsUrl(), wsFactory: browserWsFactory }),
      onStateChange: setConnState,
      onEvent: handleEvent,
    });
    orch.model.onChange(() => setSegments(orch.model.getSegments()));
    orchRef.current = orch;
    await orch.start();
  }

  async function rotateSession(reason: string): Promise<void> {
    const oldId = sessionIdRef.current;
    await orchRef.current?.stop();
    if (oldId) await finishSessionRecord({ id: oldId, endedAt: Date.now(), usageJson: JSON.stringify(meterRef.current.snapshot().sessionTotal) });
    sessionIdRef.current = null;
    meterRef.current.startNewSession();
    await startOrchestrator();
    setRotationNotice(`会话已轮换（${reason}），会议不中断`);
  }

  async function startMeeting(): Promise<void> {
    setStarting(true);
    try {
      const id = `meet_${Date.now()}`;
      const createdAt = Date.now();
      await createMeetingRecord({ id, roster, targetLanguage, createdAt });
      meetingIdRef.current = id;
      rosterRef.current = roster;
      createdAtRef.current = createdAt;
      setLastMeetingId(id);
      coordRef.current = new MeetingCoordinator({
        schedule: (cb, delayMs) => { const t = window.setTimeout(cb, delayMs); return () => window.clearTimeout(t); },
        onStateChange: (s, who) => { setHotSeat(s); setSpeaker(who); if (s === 'idle') idleSinceRef.current = Date.now(); },
      });
      const ctx = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
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
        echoCancellation: true,
        onChunk: (b) => { if (coordRef.current?.state === 'speaking') orchRef.current?.pushAudio(b); },
      });
      setRunning(true);
    } finally {
      setStarting(false);
    }
  }

  function endSpeechManually(): void {
    coordRef.current?.endSpeech();
    for (let i = 0; i < 35; i++) orchRef.current?.pushAudio(new ArrayBuffer(3200));
  }

  async function grabSeat(name: string): Promise<void> {
    const reason = shouldRotate({
      sessionInputTokens: meterRef.current.snapshot().sessionTotal.input_tokens,
      hadError: false, pausedSinceMs: hotSeat === 'idle' ? idleSinceRef.current : null, now: Date.now(),
    });
    if (reason) await rotateSession(reason);
    coordRef.current?.requestSpeak(name);
  }

  async function endMeeting(): Promise<void> {
    micRef.current?.stop(); micRef.current = null;
    await orchRef.current?.stop();
    const sessionId = sessionIdRef.current;
    if (sessionId) await finishSessionRecord({ id: sessionId, endedAt: Date.now(), usageJson: JSON.stringify(meterRef.current.snapshot().sessionTotal) });
    sessionIdRef.current = null;
    playerRef.current?.flush(); playerRef.current = null;
    void ctxRef.current?.close(); ctxRef.current = null;
    if (pollRef.current !== null) { window.clearInterval(pollRef.current); pollRef.current = null; }
    setRunning(false); setHotSeat('idle'); setSpeaker(null);
  }

  function replayTurn(t: TimelineTurn): void {
    if (!t.pcm24k) return;
    let ctx = ctxRef.current;
    if (!ctx || ctx.state === 'closed') { ctx = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE }); ctxRef.current = ctx; playerRef.current = null; }
    new StreamPlayer(ctx).enqueuePcm(t.pcm24k);
  }

  async function exportMeeting(kind: 'md' | 'txt'): Promise<void> {
    const mId = lastMeetingId;
    if (!mId) return;
    const turns = (await fetchMeetingTurns(mId)).map((t) => ({ speaker: t.speaker, sourceText: t.source_text, targetText: t.target_text, sourceLang: t.source_lang }));
    const content = kind === 'md'
      ? buildMeetingMarkdown({ roster: rosterRef.current, targetLanguage, createdAtIso: new Date(createdAtRef.current).toISOString() }, turns)
      : buildMeetingTxt(turns);
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `${mId}.${kind === 'md' ? 'md' : 'txt'}`; a.click();
    URL.revokeObjectURL(a.href);
  }

  const fmtTime = (ms: number): string => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
  const avatarColor = (name: string): string => AVATAR_COLORS[rosterRef.current.indexOf(name) % AVATAR_COLORS.length] ?? '#888';

  // === Connecting overlay ===
  if (starting) {
    return (
      <div className="connecting-overlay">
        <div className="connecting-spinner" />
        <div className="connecting-text">正在启动会议…</div>
        <div className="connecting-sub">正在建立 WebSocket 会话并初始化麦克风</div>
      </div>
    );
  }

  // === Setup view ===
  if (!running) {
    const audioOk = supportsAudioOutput(targetLanguage);
    return (
      <div className="page-content">
        <div className="page-header">
          <h1 className="page-title">会议翻译</h1>
          <p className="page-subtitle">热座串行圆桌 · 译文以发言人音色播放</p>
        </div>

        <div className="card" style={{ padding: 'var(--space-6)' }}>
          <div style={{ marginBottom: 'var(--space-5)' }}>
            <label className="label">会议目标语言（全场统一）</label>
            <select className="select" style={{ maxWidth: '240px' }} value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value)}>
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
            </select>
          </div>

          <label className="label">参会人名册</label>
          <div className="roster-list">
            {rosterEntries.map((entry, i) => (
              <div key={i} className="roster-row">
                <div className="roster-avatar" style={{ background: AVATAR_COLORS[i % AVATAR_COLORS.length] }}>
                  {(entry.name || '?').charAt(0).toUpperCase()}
                </div>
                <input className="input roster-input" placeholder="姓名" value={entry.name}
                  onChange={(e) => setRosterEntries(rosterEntries.map((r, ri) => ri === i ? { ...r, name: e.target.value } : r))} />
                <select className="select roster-select" value={entry.lang}
                  onChange={(e) => setRosterEntries(rosterEntries.map((r, ri) => ri === i ? { ...r, lang: e.target.value } : r))}>
                  <option value="auto">自动检测</option>
                  {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                </select>
                <button className="roster-remove" onClick={() => setRosterEntries(rosterEntries.filter((_, ri) => ri !== i))} disabled={rosterEntries.length <= 2}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => setRosterEntries([...rosterEntries, { name: '', lang: 'auto' }])}>
            <Plus size={14} />添加参会人
          </button>

          {!audioOk && <div className="inline-alert error" style={{ marginTop: 'var(--space-4)' }}>该目标语言仅支持文本输出，会议模式需要语音播报，请改选支持语音的语言。</div>}
          <button className="btn btn-primary btn-lg" style={{ marginTop: 'var(--space-6)', width: '100%' }}
            disabled={roster.length < 2 || !audioOk} onClick={() => void startMeeting()}>
            开始会议
          </button>
        </div>

        {lastMeetingId && (
          <div style={{ marginTop: 'var(--space-5)', display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
            <span style={{ fontSize: '13px', color: 'var(--color-text-tertiary)' }}>上一场：{lastMeetingId}</span>
            <button className="btn btn-secondary btn-sm" onClick={() => void exportMeeting('md')}>导出 Markdown</button>
            <button className="btn btn-secondary btn-sm" onClick={() => void exportMeeting('txt')}>导出 TXT</button>
          </div>
        )}
      </div>
    );
  }

  // === Running view ===
  const live = segments[segments.length - 1];
  const showLive = hotSeat !== 'idle' && live && live.status !== 'done';

  return (
    <div className="page-content" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h1 className="page-title">会议翻译</h1>
          <p className="page-subtitle">热座串行圆桌 · 译文以发言人音色播放</p>
        </div>
        <span className="badge badge-primary" style={{ marginTop: '6px', padding: '4px 12px', fontSize: '12px' }}>
          会议语言：{LANGUAGES.find((l) => l.code === targetLanguage)?.name ?? targetLanguage}
        </span>
      </div>

      {connState === 'reconnecting' && <div className="toast-bar warning">连接中断，正在重连……</div>}
      {rotationNotice && <p style={{ fontSize: '12px', color: 'var(--color-text-tertiary)', marginBottom: 'var(--space-3)' }}>{rotationNotice}</p>}

      {/* Speaker ring */}
      <div className="speaker-ring">
        {rosterRef.current.map((name) => (
          <div key={name} className={`speaker-avatar${speaker === name && hotSeat !== 'idle' ? ' speaking' : ''}`}>
            <div className="avatar-circle" style={{ background: avatarColor(name) }}>{name.charAt(0).toUpperCase()}</div>
            <span className="speaker-name">{name}</span>
          </div>
        ))}
      </div>

      {/* Live caption */}
      {showLive && (
        <div className="meeting-caption card">
          <div className="meeting-caption-source">
            {live.sourceText}{live.sourceStash && <span className="stash">{live.sourceStash}</span>}
          </div>
          <div className="meeting-caption-target">
            {live.targetText}{live.targetStash && <span className="stash">{live.targetStash}</span>}
          </div>
        </div>
      )}

      {/* Turn timeline */}
      <div className="turn-timeline">
        {timeline.map((t) => (
          <div key={t.key} className="turn-card">
            <div className="turn-avatar" style={{ background: avatarColor(t.speaker) }}>{t.speaker.charAt(0).toUpperCase()}</div>
            <div className="turn-body">
              <div className="turn-header">
                <span className="turn-name">{t.speaker}</span>
                <span className="turn-time">{fmtTime(t.doneAt)}</span>
                {t.sourceLang && <span className="badge badge-neutral" style={{ fontSize: '10px' }}>{t.sourceLang}</span>}
              </div>
              {t.sourceLang && t.sourceLang !== targetLanguage && <div className="turn-source">{t.sourceText}</div>}
              <div className="turn-target">{t.targetText}</div>
              {t.pcm24k && (
                <button className="segment-replay turn-replay" onClick={() => replayTurn(t)}><Play size={12} />重播</button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Dock */}
      <div className="meeting-dock">
        {rosterRef.current.map((name) => (
          <button key={name} className="speak-btn" disabled={hotSeat !== 'idle'}
            onClick={() => void grabSeat(name)} style={{ padding: '10px 24px', fontSize: '14px' }}>
            {hotSeat === 'idle' ? `${name} 发言` : '等待中…'}
          </button>
        ))}
        {hotSeat === 'speaking' && <button className="btn btn-secondary btn-sm" onClick={endSpeechManually}>结束发言</button>}
        {hotSeat === 'translating' && (
          <span className="translating-badge"><Loader2 size={14} className="spin" /> 正在翻译…</span>
        )}
        {hotSeat === 'playing' && (
          <button className="btn btn-ghost btn-sm" onClick={() => { playerRef.current?.flush(); coordRef.current?.skipPlayback(); }}>跳过播放</button>
        )}
        <button className="btn btn-danger-ghost btn-sm" onClick={() => void endMeeting()}>结束会议</button>
      </div>
    </div>
  );
}
