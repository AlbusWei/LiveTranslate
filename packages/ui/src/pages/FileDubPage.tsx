import { useEffect, useRef, useState } from 'react';
import {
  LANGUAGES, OUTPUT_SAMPLE_RATE, bytesToBase64, supportsAudioOutput, wavDurationSeconds,
  type DubPlacement, type DubSegmentTiming,
} from '@livetranslate/core';
import {
  createGatewayApi, createMediaJob, exportUrl, fetchMediaJob, fetchSegmentAudio, fetchSegments, mediaFileUrl,
  type MediaJobStatusDto, type SegmentDto,
} from '../api';
import { createPlayerSink } from '../audio/playerSink';
import { DriftBar } from '../components/DriftBar';
import { SegmentWave } from '../components/SegmentWave';
import { DubPlaybackController } from '../state/dubPlayback';

type Phase = 'pick' | 'uploading' | 'processing' | 'done' | 'failed';

const fmtMs = (ms: number | null): string => {
  if (ms === null) return '--:--';
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// WAV（PCM16LE mono）→ 归一化采样：右栏译文段波形用
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
  const [voiceClone, setVoiceClone] = useState(true); // spec 5.2：once 复刻默认开
  const [framesEnabled, setFramesEnabled] = useState(true); // spec 5.2：抽帧增强默认开（仅视频）
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<MediaJobStatusDto | null>(null);
  const [segments, setSegments] = useState<SegmentDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const sink = useRef(createPlayerSink());
  // 原声播放：原始媒体走原时间轴，双栏按 VAD 起止同步高亮（spec 5.2 工作台）
  const mediaRef = useRef<HTMLAudioElement | HTMLVideoElement | null>(null);
  const [srcSeq, setSrcSeq] = useState<number | null>(null);
  // 配音回放（T24）：顺延时间轴调度 + 漂移可视化
  const [placements, setPlacements] = useState<DubPlacement[]>([]);
  const [dubPlaying, setDubPlaying] = useState(false);
  const [currentSeq, setCurrentSeq] = useState<number | null>(null);
  const [dubWaves, setDubWaves] = useState<Map<number, Float32Array>>(new Map());
  const [srcAudio, setSrcAudio] = useState<{ samples: Float32Array; sampleRate: number } | null>(null);
  const audioCache = useRef(new Map<number, Uint8Array>());
  const controller = useRef<DubPlaybackController | null>(null);

  async function initDubPlayback(segs: SegmentDto[], sessionId: string): Promise<void> {
    const timings: DubSegmentTiming[] = [];
    const waves = new Map<number, Float32Array>();
    for (const s of segs) {
      if (!s.audio_path || s.vad_start_ms === null || s.vad_end_ms === null) continue;
      const wav = await fetchSegmentAudio(sessionId, s.seq);
      audioCache.current.set(s.seq, wav);
      waves.set(s.seq, wavToFloat32(wav));
      timings.push({
        seq: s.seq,
        srcStartMs: s.vad_start_ms,
        srcEndMs: s.vad_end_ms,
        dubDurationMs: Math.round(wavDurationSeconds(wav.length - 44, OUTPUT_SAMPLE_RATE) * 1000), // 去掉 44 字节 WAV 头
      });
    }
    const c = new DubPlaybackController({
      now: () => performance.now(),
      schedule: (cb, delayMs) => {
        const handle = window.setTimeout(cb, delayMs);
        return () => window.clearTimeout(handle);
      },
      playSegment: (seq) => {
        const wav = audioCache.current.get(seq);
        if (wav) void sink.current.play(wav);
      },
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

  // 左栏原声波形：解码失败仅降级不显示，不阻断工作台
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
      } catch { /* 波形是增强展示 */ }
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

  // 轮询作业状态（T21 进度存内存，1s 一次足够）
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
      const id = await createMediaJob({
        fileName: file.name,
        dataBase64: bytesToBase64(bytes),
        isVideo,
        targetLanguage,
        voiceClone,
        voice,
        framesEnabled: isVideo && framesEnabled,
      });
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

  // 原始媒体 timeupdate → 命中 VAD 区间的段（原声播放高亮）
  function onSourceTimeUpdate(): void {
    const el = mediaRef.current;
    if (!el || el.paused) return;
    const t = el.currentTime * 1000;
    const hit = segments.find((s) => s.vad_start_ms !== null && s.vad_end_ms !== null && s.vad_start_ms <= t && t < s.vad_end_ms);
    setSrcSeq(hit ? hit.seq : null);
  }

  // 配音回放：只出右侧译文声；视频时左栏画面按原时间轴静音同步
  function startDubPlayback(): void {
    const c = controller.current;
    if (!c) return;
    mediaRef.current?.pause();
    if (isVideo && mediaRef.current) {
      mediaRef.current.muted = true;
      mediaRef.current.currentTime = c.positionMs() / 1000;
      void mediaRef.current.play();
    }
    c.play();
    setDubPlaying(true);
  }

  function pauseDubPlayback(): void {
    controller.current?.pause();
    sink.current.stop();
    if (isVideo && mediaRef.current) {
      mediaRef.current.pause();
      mediaRef.current.muted = false;
    }
    setDubPlaying(false);
  }

  const progress = status?.progress ?? null;
  const pct = progress && progress.totalMs > 0 ? Math.round((progress.doneMs / progress.totalMs) * 100) : 0;

  return (
    <div className="filedub-page">
      <h2>翻译机·配音</h2>
      {phase === 'pick' && (
        <div className="config-panel">
          <label>
            音视频文件
            <input
              type="file"
              accept="audio/*,video/*"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                setIsVideo(f?.type.startsWith('video/') ?? false);
              }}
            />
          </label>
          <label>
            目标语言
            <select value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value)}>
              {LANGUAGES.filter((l) => l.audio).map((l) => (
                <option key={l.code} value={l.code}>{l.name}</option>
              ))}
            </select>
          </label>
          <label>
            <input type="checkbox" checked={voiceClone} onChange={(e) => setVoiceClone(e.target.checked)} />
            音色复刻（once，取文件开头人声）
          </label>
          {!voiceClone && (
            <label>
              预置音色
              <input value={voice} onChange={(e) => setVoice(e.target.value)} />
            </label>
          )}
          {isVideo && (
            <label>
              <input type="checkbox" checked={framesEnabled} onChange={(e) => setFramesEnabled(e.target.checked)} />
              抽帧视觉增强（提升专名/术语翻译，额外消耗 token）
            </label>
          )}
          <button disabled={!file || !supportsAudioOutput(targetLanguage)} onClick={() => void start()}>开始预处理</button>
          {file && !supportsAudioOutput(targetLanguage) && <p className="error-text">该目标语言不支持语音输出，请换音频支持语种</p>}
        </div>
      )}
      {(phase === 'uploading' || phase === 'processing') && (
        <div className="dub-progress">
          <p>{phase === 'uploading' ? '上传中…' : `全速预处理中（P8，不限速）：${fmtMs(progress?.doneMs ?? 0)} / ${fmtMs(progress?.totalMs ?? null)}`}</p>
          <progress max={100} value={pct} />
        </div>
      )}
      {phase === 'failed' && (
        <div className="dub-progress">
          <p className="error-text">{error}</p>
          <button onClick={() => { setPhase('pick'); setJobId(null); setStatus(null); }}>重新选择</button>
        </div>
      )}
      {phase === 'done' && jobId && (
        <div className="dub-workbench">
          <div className="dub-source-media">
            <h3>原始媒体</h3>
            {isVideo
              ? <video controls src={mediaFileUrl(jobId)} className="dub-video" ref={(el) => { mediaRef.current = el; }} onTimeUpdate={onSourceTimeUpdate} onPause={() => setSrcSeq(null)} onEnded={() => setSrcSeq(null)} />
              : <audio controls src={mediaFileUrl(jobId)} ref={(el) => { mediaRef.current = el; }} onTimeUpdate={onSourceTimeUpdate} onPause={() => setSrcSeq(null)} onEnded={() => setSrcSeq(null)} />}
            <button className="secondary" onClick={() => { void mediaRef.current?.play(); }}>▶ 原声播放</button>
          </div>
          <div className="dub-playback">
            <button disabled={dubPlaying} onClick={startDubPlayback}>▶ 配音回放</button>
            <button disabled={!dubPlaying} onClick={pauseDubPlayback}>⏸ 暂停</button>
            <button onClick={() => { pauseDubPlayback(); controller.current?.seek(0); setCurrentSeq(null); }}>⏮ 回到开头</button>
            <DriftBar placements={placements} currentSeq={currentSeq} totalMs={progress?.totalMs ?? 0} />
          </div>
          {status?.job.session_id && (
            <div className="dub-exports">
              <a href={exportUrl('srt', status.job.session_id)} download>导出 SRT</a>
              <a href={exportUrl('txt', status.job.session_id)} download>导出双语 TXT</a>
              <a href={exportUrl('dub-wav', status.job.session_id)} download>导出混音 WAV</a>
            </div>
          )}
          <div className="dub-columns">
            <div className="dub-col">
              <h3>原文</h3>
              {segments.map((s) => (
                <div key={s.seq} className={`dub-cell${srcSeq === s.seq || currentSeq === s.seq ? ' playing' : ''}`}>
                  <span className="segment-meta">{fmtMs(s.vad_start_ms)}–{fmtMs(s.vad_end_ms)}{s.source_lang ? ` · ${s.source_lang}` : ''}</span>
                  <p className="segment-source">{s.source_text}</p>
                  {srcAudio && s.vad_start_ms !== null && s.vad_end_ms !== null && (
                    <SegmentWave samples={srcAudio.samples.subarray(
                      Math.floor((s.vad_start_ms / 1000) * srcAudio.sampleRate),
                      Math.floor((s.vad_end_ms / 1000) * srcAudio.sampleRate),
                    )} color="#6a9" />
                  )}
                </div>
              ))}
            </div>
            <div className="dub-col">
              <h3>译文</h3>
              {segments.map((s) => {
                const p = placements.find((x) => x.seq === s.seq);
                return (
                  <div key={s.seq} className={`dub-cell${srcSeq === s.seq || currentSeq === s.seq ? ' playing' : ''}`}>
                    <span className="segment-meta">
                      #{s.seq}
                      {p && ` · 时长 ${((p.dubEndMs - p.dubStartMs) / 1000).toFixed(1)}s`}
                      {p && p.driftMs > 0 && <span className="warn-text"> · 漂移 +{(p.driftMs / 1000).toFixed(1)}s</span>}
                    </span>
                    <p className="segment-target">{s.target_text}</p>
                    {dubWaves.get(s.seq) && <SegmentWave samples={dubWaves.get(s.seq)!} />}
                    {s.audio_path && <button onClick={() => void playSegment(s)}>▶ 播放译文</button>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
