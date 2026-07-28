import type { TranscriptSegment } from '@livetranslate/core';

export interface SegmentCardProps {
  segment: TranscriptSegment;
  audio?: { durationSec: number; onPlay: () => void } | null;
  tokensDelta?: number | null; // 会议模式（T33）传入每段增量 tokens
}

export function SegmentCard({ segment, audio, tokensDelta }: SegmentCardProps): JSX.Element {
  return (
    <div className={`segment-card status-${segment.status}`}>
      <div className="segment-source">
        <span>{segment.sourceText}</span>
        {segment.sourceStash && <span className="stash">{segment.sourceStash}</span>}
        {segment.status === 'done' && segment.sourceLang && (
          <span className="lang-tag">［{segment.sourceLang}{segment.emotion ? ` · ${segment.emotion}` : ''}］</span>
        )}
      </div>
      <div className="segment-target">
        <span>{segment.targetText}</span>
        {segment.targetStash && <span className="stash">{segment.targetStash}</span>}
        {segment.status === 'interrupted' && <span className="warn-banner">段落中断</span>}
      </div>
      <div className="segment-meta">
        {audio && <button onClick={audio.onPlay}>▶ {audio.durationSec.toFixed(1)}s</button>}
        {typeof tokensDelta === 'number' && <span className="usage-tag">+{tokensDelta} tok</span>}
      </div>
    </div>
  );
}
