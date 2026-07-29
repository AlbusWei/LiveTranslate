import type { TranscriptSegment } from '@livetranslate/core';

interface SubtitleOverlayProps {
  segments: readonly TranscriptSegment[];
  channelKind: string;
  latencyMs: number | null;
  paused: boolean;
  onPause(): void;
  onResume(): void;
  onEnd(): void;
}

export function SubtitleOverlay(props: SubtitleOverlayProps): JSX.Element {
  const { segments, channelKind, latencyMs, paused, onPause, onResume, onEnd } = props;
  const latest = segments[segments.length - 1];
  const prev = segments[segments.length - 2];

  return (
    <div className="subtitle-overlay">
      <div className="subtitle-glow" />
      <div className="subtitle-topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <span className="badge">{channelKind === 'webrtc' ? 'WebRTC 通道' : 'WS 通道'}</span>
          <span className="perf-badge">
            <span className="dot" />
            {latencyMs !== null ? `${(latencyMs / 1000).toFixed(1)}s 响应` : '—'}
          </span>
        </div>
        <div className="sub-controls">
          {paused
            ? <button className="sub-ctrl-btn" onClick={onResume}>恢复</button>
            : <button className="sub-ctrl-btn" onClick={onPause}>暂停</button>}
          <button className="sub-ctrl-btn end" onClick={onEnd}>结束</button>
        </div>
      </div>
      <div className="subtitle-stage">
        {prev && (
          <div className="sub-prev">
            <div className="sub-source">{prev.sourceText}</div>
            <div className="sub-target" style={{ fontSize: '28px', opacity: 0.6 }}>{prev.targetText}</div>
          </div>
        )}
        {latest ? (
          <div className="sub-current">
            <div className="sub-source">
              {latest.sourceText}
              {latest.sourceStash && <span className="stash">{latest.sourceStash}</span>}
            </div>
            <div className="sub-target">
              {latest.targetText}
              {latest.targetStash && <span className="stash">{latest.targetStash}</span>}
            </div>
          </div>
        ) : (
          <div className="sub-current">
            <div className="sub-source">请开始说话……</div>
          </div>
        )}
        <div className="sub-listening">
          <span>正在聆听</span>
          <span className="listening-dots"><span /><span /><span /></span>
        </div>
      </div>
    </div>
  );
}
