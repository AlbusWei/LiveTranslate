import { useEffect, useRef, useState } from 'react';
import {
  LANGUAGES, OUTPUT_SAMPLE_RATE, bytesToBase64, supportsAudioOutput, wavDurationSeconds,
  type DubPlacement, type DubSegmentTiming,
} from '@livetranslate/core';
import { Upload, Film, Play, Pause, SkipBack, Download, ChevronDown } from 'lucide-react';
import {
  createGatewayApi, createMediaJob, exportUrl, fetchMediaJob, fetchSegmentAudio, fetchSegments, mediaFileUrl,
  type MediaJobStatusDto, type SegmentDto,
} from '../api';
import { createPlayerSink } from '../audio/playerSink';
import { DriftBar } from '../components/DriftBar';
import { DubPlaybackController } from '../state/dubPlayback';

type Phase = 'pick' | 'uploading' | 'processing' | 'done' | 'failed';

const fmtMs = (ms: number | null): string => {
  if (ms === null) return '--:--';
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const wavToFloat32 = (wav: Uint8Array): Float32Array => {
  const pcm = wav.subarray(44);
  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out = new Float32Array(Math.floor(pcm.byteLength / 2));
  for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(i * 2, true) / 32768;
  return out;
};

export function FileDubPage(): JSX.Element {
  const [phase, setPhase] = useState<Phase>('pick');
  const [file, setFile] = useState<File | null>(null);
  const [isVideo, setIsVideo] = useState(false);
  const [targetLanguage, setTargetLanguage] = useState('en');
  const [voice, setVoice] = useState('Tina');
  const [voiceClone, setVoiceClone] = useState(true);
  const [framesEnabled, setFramesEnabled] = useState(true);
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<MediaJobStatusDto | null>(null);
  const [segments, setSegments] = useState<SegmentDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const sink = useRef(createPlayerSink());
  const mediaRef = useRef<HTMLAudioElement | HTMLVideoElement | null>(null);
  const [srcSeq, setSrcSeq] = useState<number | null>(null);
  const [placements, setPlacements] = useState<DubPlacement[]>([]);
  const [dubPlaying, setDubPlaying] = useState(false);
  const [currentSeq, setCurrentSeq] = useState<number | null>(null);
  const [dubWaves, setDubWaves] = useState<Map<number, Float32Array>>(new Map());
  const [srcAudio, setSrcAudio] = useState<{ samples: Float32Array; sampleRate: number } | null>(null);
  const audioCache = useRef(new Map<number, Uint8Array>());
  const controller = useRef<DubPlaybackController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function initDubPlayback(segs: SegmentDto[], sessionId: string): Promise<void> {
    const timings: DubSegmentTiming[] = [];
    const waves = new Map<number, Float32Array>();
    for (const s of segs) {
      if (!s.audio_path || s.vad_start_ms === null || s.vad_end_ms === null) continue;
      const wav = await fetchSegmentAudio(sessionId, s.seq);
      audioCache.current.set(s.seq, wav);
      waves.set(s.seq, wavToFloat32(wav));
      timings.push({ seq: s.seq, srcStartMs: s.vad_start_ms, srcEndMs: s.vad_end_ms, dubDurationMs: Math.round(wavDurationSeconds(wav.length - 44, OUTPUT_SAMPLE_RATE) * 1000) });
    }
    const c = new DubPlaybackController({
      now: () => performance.now(),
      schedule: (cb, delayMs) => { const h = window.setTimeout(cb, delayMs); return () => window.clearTimeout(h); },
      playSegment: (seq) => { const wav = audioCache.current.get(seq); if (wav) void sink.current.play(wav); },
    });
    setPlacements(c.load(timings));
    setDubWaves(waves);
    controller.current = c;
  }

  useEffect(() => {
    if (!dubPlaying) return;
    const handle = setInterval(() => setCurrentSeq(controller.current?.currentSeq() ?? null), 200);
    return () => clearInterval(handle);
  }, [dubPlaying]);

  useEffect(() => {
    if (phase !== 'done' || !jobId) return;
    let cancelled = false;
    void (async () => {
      try {
        const buf = await (await fetch(mediaFileUrl(jobId))).arrayBuffer();
        const ac = new AudioContext();
        const decoded = await ac.decodeAudioData(buf);
        void ac.close();
        if (!cancelled) setSrcAudio({ samples: decoded.getChannelData(0), sampleRate: decoded.sampleRate });
      } catch { /* waveform is enhancement */ }
    })();
    return () => { cancelled = true; };
  }, [phase, jobId]);

  useEffect(() => {
    void createGatewayApi().getSettings().then(({ settings }) => {
      setTargetLanguage(settings.targetLanguage);
      setVoice(settings.defaultVoice);
      setFramesEnabled(settings.frameExtraction.enabled);
    });
  }, []);

  useEffect(() => {
    if (!jobId || phase !== 'processing') return;
    const timer = setInterval(() => {
      void fetchMediaJob(jobId).then(async (st) => {
        if (!st) return;
        setStatus(st);
        if (st.job.status === 'done' && st.job.session_id) {
          clearInterval(timer);
          const segs = await fetchSegments(st.job.session_id);
          setSegments(segs);
          await initDubPlayback(segs, st.job.session_id);
          setPhase('done');
        } else if (st.job.status === 'failed') {
          clearInterval(timer);
          setError(st.job.artifacts_json ? (JSON.parse(st.job.artifacts_json) as { error: string }).error : '预处理失败');
          setPhase('failed');
        }
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [jobId, phase]);

  async function start(): Promise<void> {
    if (!file) return;
    setPhase('uploading');
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const id = await createMediaJob({ fileName: file.name, dataBase64: bytesToBase64(bytes), isVideo, targetLanguage, voiceClone, voice, framesEnabled: isVideo && framesEnabled });
      setJobId(id);
      setPhase('processing');
    } catch (err) {
      setError(String(err));
      setPhase('failed');
    }
  }

  async function playSegment(seg: SegmentDto): Promise<void> {
    if (!seg.audio_path || !status?.job.session_id) return;
    const wav = await fetchSegmentAudio(status.job.session_id, seg.seq);
    await sink.current.play(wav);
  }

  function onSourceTimeUpdate(): void {
    const el = mediaRef.current;
    if (!el || el.paused) return;
    const t = el.currentTime * 1000;
    const hit = segments.find((s) => s.vad_start_ms !== null && s.vad_end_ms !== null && s.vad_start_ms <= t && t < s.vad_end_ms);
    setSrcSeq(hit ? hit.seq : null);
  }

  function startDubPlayback(): void {
    const c = controller.current;
    if (!c) return;
    mediaRef.current?.pause();
    if (isVideo && mediaRef.current) { mediaRef.current.muted = true; mediaRef.current.currentTime = c.positionMs() / 1000; void mediaRef.current.play(); }
    c.play();
    setDubPlaying(true);
  }

  function pauseDubPlayback(): void {
    controller.current?.pause();
    sink.current.stop();
    if (isVideo && mediaRef.current) { mediaRef.current.pause(); mediaRef.current.muted = false; }
    setDubPlaying(false);
  }

  const progress = status?.progress ?? null;
  const pct = progress && progress.totalMs > 0 ? Math.round((progress.doneMs / progress.totalMs) * 100) : 0;

  return (
    <div className="page-content" style={{ maxWidth: '1000px', display: 'flex', flexDirection: 'column' }}>
      <div className="page-header">
        <h1 className="page-title">文件配音</h1>
        <p className="page-subtitle">导入音视频文件，全速预处理后获得双语配音</p>
      </div>

      {/* Pick phase: DropZone */}
      {phase === 'pick' && (
        <>
          <div className="dropzone" onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) { setFile(f); setIsVideo(f.type.startsWith('video/')); } }}>
            <div className="dropzone-icon"><Upload size={24} /></div>
            <div className="dropzone-title">拖入音频或视频文件</div>
            <div className="dropzone-desc">支持 MP3、WAV、M4A、MP4、WebM 等格式</div>
          </div>
          <input ref={fileInputRef} type="file" accept="audio/*,video/*" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); setIsVideo(f?.type.startsWith('video/') ?? false); }} />

          {file && (
            <div className="card" style={{ marginTop: 'var(--space-5)', padding: 'var(--space-5)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
                <div className="dub-file-icon"><Film size={16} /></div>
                <div>
                  <div className="dub-file-name">{file.name}</div>
                  <div className="dub-file-meta">{(file.size / 1024 / 1024).toFixed(1)} MB · {isVideo ? '视频' : '音频'}</div>
                </div>
              </div>
              <div className="config-grid" style={{ marginBottom: 'var(--space-4)' }}>
                <div>
                  <label className="label">目标语言</label>
                  <select className="select" value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value)}>
                    {LANGUAGES.filter((l) => l.audio).map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">预置音色</label>
                  <select className="select" value={voice} onChange={(e) => setVoice(e.target.value)} disabled={voiceClone}>
                    <option value="Tina">Tina</option><option value="Cherry">Cherry</option><option value="Ethan">Ethan</option>
                  </select>
                </div>
              </div>
              <div className="config-row">
                <span className="config-row-label">音色复刻（取文件开头人声）</span>
                <button className={`switch${voiceClone ? ' on' : ''}`} role="switch" aria-checked={voiceClone} aria-label="音色复刻" onClick={() => setVoiceClone(!voiceClone)} />
              </div>
              {isVideo && (
                <div className="config-row">
                  <span className="config-row-label">抽帧视觉增强（额外消耗 token）</span>
                  <button className={`switch${framesEnabled ? ' on' : ''}`} role="switch" aria-checked={framesEnabled} aria-label="抽帧视觉增强" onClick={() => setFramesEnabled(!framesEnabled)} />
                </div>
              )}
              {!supportsAudioOutput(targetLanguage) && <div className="inline-alert error" style={{ marginTop: 'var(--space-3)' }}>该目标语言不支持语音输出，请换音频支持语种</div>}
              <button className="btn btn-primary" style={{ marginTop: 'var(--space-4)' }} disabled={!supportsAudioOutput(targetLanguage)} onClick={() => void start()}>开始预处理</button>
            </div>
          )}
        </>
      )}

      {/* Processing phase */}
      {(phase === 'uploading' || phase === 'processing') && (
        <div className="card" style={{ padding: 'var(--space-8)', textAlign: 'center', marginTop: 'var(--space-8)' }}>
          <div className="dub-file-name" style={{ marginBottom: 'var(--space-4)' }}>{file?.name}</div>
          <div className="progress-bar" style={{ maxWidth: '400px', margin: '0 auto var(--space-3)' }}>
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>
            {phase === 'uploading' ? '上传中…' : `正在翻译… ${fmtMs(progress?.doneMs ?? 0)} / ${fmtMs(progress?.totalMs ?? null)} (${pct}%)`}
          </p>
        </div>
      )}

      {/* Failed phase */}
      {phase === 'failed' && (
        <div className="card" style={{ padding: 'var(--space-8)', textAlign: 'center', marginTop: 'var(--space-8)' }}>
          <div className="inline-alert error">{error}</div>
          <button className="btn btn-secondary" onClick={() => { setPhase('pick'); setJobId(null); setStatus(null); }}>重新选择</button>
        </div>
      )}

      {/* Done phase: Workbench */}
      {phase === 'done' && jobId && (
        <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div className="dub-toolbar">
            <div className="dub-file-info">
              <div className="dub-file-icon"><Film size={16} /></div>
              <div>
                <div className="dub-file-name">{file?.name ?? '文件'}</div>
                <div className="dub-file-meta">{fmtMs(progress?.totalMs ?? null)} · 预处理完成</div>
              </div>
            </div>
            <div className="dub-toolbar-actions">
              {status?.job.session_id && (
                <>
                  <a className="btn btn-secondary btn-sm" href={exportUrl('srt', status.job.session_id)} download><Download size={13} />SRT</a>
                  <a className="btn btn-secondary btn-sm" href={exportUrl('txt', status.job.session_id)} download>TXT</a>
                  <a className="btn btn-secondary btn-sm" href={exportUrl('dub-wav', status.job.session_id)} download>WAV</a>
                </>
              )}
            </div>
          </div>

          <div className="dub-workbench">
            <div className="dub-panel dub-panel-left">
              <div className="dub-video-area">
                {isVideo ? (
                  <video src={mediaFileUrl(jobId)} style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                    ref={(el) => { mediaRef.current = el; }} onTimeUpdate={onSourceTimeUpdate} onPause={() => setSrcSeq(null)} onEnded={() => setSrcSeq(null)} />
                ) : (
                  <div className="dub-video-placeholder">
                    <Film size={32} />
                    <span>纯音频文件</span>
                    <audio src={mediaFileUrl(jobId)} style={{ display: 'none' }}
                      ref={(el) => { mediaRef.current = el; }} onTimeUpdate={onSourceTimeUpdate} onPause={() => setSrcSeq(null)} onEnded={() => setSrcSeq(null)} />
                  </div>
                )}
              </div>
              <div className="dub-timeline">
                <div className="dub-timeline-wave">
                  {srcAudio && Array.from({ length: 80 }, (_, i) => {
                    const idx = Math.floor((i / 80) * srcAudio.samples.length);
                    const v = Math.abs(srcAudio.samples[idx] ?? 0);
                    return <i key={i} style={{ height: `${Math.max(3, v * 30)}px` }} />;
                  })}
                </div>
              </div>
              <div style={{ marginTop: 'var(--space-4)' }}>
                {segments.map((s) => (
                  <div key={s.seq} className={`dub-seg-card${srcSeq === s.seq ? ' playing' : ''}`}>
                    <div className="dub-seg-time">{fmtMs(s.vad_start_ms)} – {fmtMs(s.vad_end_ms)}</div>
                    <div className="dub-seg-text" style={{ color: 'var(--color-text-secondary)', fontSize: '14px' }}>{s.source_text}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="dub-panel">
              {segments.map((s) => {
                const p = placements.find((x) => x.seq === s.seq);
                return (
                  <div key={s.seq} className={`dub-seg-card${currentSeq === s.seq ? ' playing' : ''}`}>
                    <div className="dub-seg-time">
                      {fmtMs(s.vad_start_ms)} – {fmtMs(s.vad_end_ms)}
                      {p && p.driftMs > 0 && <span style={{ color: 'var(--color-warning)', marginLeft: '6px' }}>+{(p.driftMs / 1000).toFixed(1)}s</span>}
                    </div>
                    <div className="dub-seg-text">{s.target_text}</div>
                    <div className="dub-seg-wave">
                      {dubWaves.get(s.seq) && Array.from({ length: 40 }, (_, i) => {
                        const samples = dubWaves.get(s.seq)!;
                        const idx = Math.floor((i / 40) * samples.length);
                        return <i key={i} style={{ height: `${Math.max(3, Math.abs(samples[idx] ?? 0) * 24)}px` }} />;
                      })}
                    </div>
                    {s.audio_path && (
                      <button className="segment-replay" style={{ marginTop: 'var(--space-2)' }} onClick={() => void playSegment(s)}>
                        <Play size={12} />播放
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="dub-transport">
            <button className="transport-play" onClick={() => dubPlaying ? pauseDubPlayback() : startDubPlayback()}>
              {dubPlaying ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <button className="dock-icon-btn" title="回到开头" onClick={() => { pauseDubPlayback(); controller.current?.seek(0); setCurrentSeq(null); }}>
              <SkipBack size={16} />
            </button>
            <div className="transport-progress">
              <div className="transport-fill" style={{ width: `${currentSeq ? ((placements.find((p) => p.seq === currentSeq)?.dubEndMs ?? 0) / (progress?.totalMs ?? 1)) * 100 : 0}%` }} />
            </div>
            <span className="transport-time">{fmtMs(progress?.totalMs ?? null)}</span>
          </div>
          <DriftBar placements={placements} currentSeq={currentSeq} totalMs={progress?.totalMs ?? 0} />
        </div>
      )}
    </div>
  );
}
