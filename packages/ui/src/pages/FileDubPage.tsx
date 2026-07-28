import { useEffect, useRef, useState } from 'react';
import { LANGUAGES, bytesToBase64, supportsAudioOutput } from '@livetranslate/core';
import {
  createGatewayApi, createMediaJob, fetchMediaJob, fetchSegmentAudio, fetchSegments, mediaFileUrl,
  type MediaJobStatusDto, type SegmentDto,
} from '../api';
import { createPlayerSink } from '../audio/playerSink';

type Phase = 'pick' | 'uploading' | 'processing' | 'done' | 'failed';

const fmtMs = (ms: number | null): string => {
  if (ms === null) return '--:--';
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
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
          setSegments(await fetchSegments(st.job.session_id));
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
          <div className="dub-columns">
            <div className="dub-col">
              <h3>原文</h3>
              {segments.map((s) => (
                <div key={s.seq} className={`dub-cell${srcSeq === s.seq ? ' playing' : ''}`}>
                  <span className="segment-meta">{fmtMs(s.vad_start_ms)}–{fmtMs(s.vad_end_ms)}{s.source_lang ? ` · ${s.source_lang}` : ''}</span>
                  <p className="segment-source">{s.source_text}</p>
                </div>
              ))}
            </div>
            <div className="dub-col">
              <h3>译文</h3>
              {segments.map((s) => (
                <div key={s.seq} className={`dub-cell${srcSeq === s.seq ? ' playing' : ''}`}>
                  <span className="segment-meta">#{s.seq}</span>
                  <p className="segment-target">{s.target_text}</p>
                  {s.audio_path && <button onClick={() => void playSegment(s)}>▶ 播放译文</button>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
