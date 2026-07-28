import type { DubPlacement } from '@livetranslate/core';

export interface DriftBarProps {
  placements: DubPlacement[];
  currentSeq: number | null;
  totalMs: number; // 原始媒体总时长，用于横轴刻度
}

export function DriftBar({ placements, currentSeq, totalMs }: DriftBarProps): JSX.Element {
  const maxMs = Math.max(totalMs, ...placements.map((p) => p.dubEndMs), 1);
  return (
    <div className="drift-bar">
      {placements.map((p) => (
        <div
          key={p.seq}
          className={`drift-chip${p.seq === currentSeq ? ' active' : ''}${p.driftMs > 0 ? ' drifted' : ''}`}
          style={{ left: `${(p.dubStartMs / maxMs) * 100}%`, width: `${((p.dubEndMs - p.dubStartMs) / maxMs) * 100}%` }}
          title={`#${p.seq} 漂移 +${(p.driftMs / 1000).toFixed(1)}s`}
        />
      ))}
    </div>
  );
}
