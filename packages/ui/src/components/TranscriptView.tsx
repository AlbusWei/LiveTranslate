import type { TranscriptSegment } from '@livetranslate/core';

export function TranscriptView({ segments, extra }: {
  segments: readonly TranscriptSegment[];
  extra?: (seg: TranscriptSegment) => JSX.Element | null;
}): JSX.Element {
  return (
    <div>
      {segments.map((s) => (
        <div key={s.seq} className="segment-card">
          <div className="source">
            {s.sourceText}<span className="stash">{s.sourceStash}</span>
            {s.sourceLang && <em>［{s.sourceLang}{s.emotion ? ` · ${s.emotion}` : ''}］</em>}
          </div>
          <div className="target">
            {s.targetText}<span className="stash">{s.targetStash}</span>
            {s.status === 'interrupted' && <span className="stash">（中断）</span>}
          </div>
          {extra?.(s)}
        </div>
      ))}
    </div>
  );
}
