import type { UsageSnapshot } from '@livetranslate/core';

export interface UsageDashboardProps {
  snapshot: UsageSnapshot | null;
  firstDeltaLatencyMs: number | null;
  sessionSeconds: number;
}

const fmt = (n: number): string => n.toLocaleString('en-US');

export function UsageDashboard({ snapshot, firstDeltaLatencyMs, sessionSeconds }: UsageDashboardProps): JSX.Element {
  const s = snapshot;
  const mm = Math.floor(sessionSeconds / 60);
  const ss = String(Math.floor(sessionSeconds % 60)).padStart(2, '0');
  return (
    <section className="usage-dashboard">
      <div className="metric"><span className="metric-label">会话 tokens</span><span className="metric-value">{fmt(s?.sessionTotal.total_tokens ?? 0)}</span></div>
      <div className="metric"><span className="metric-label">输入 音频/文本</span><span className="metric-value">{fmt(s?.sessionTotal.input_tokens_details.audio_tokens ?? 0)} / {fmt(s?.sessionTotal.input_tokens_details.text_tokens ?? 0)}</span></div>
      <div className="metric"><span className="metric-label">输出 音频/文本</span><span className="metric-value">{fmt(s?.sessionTotal.output_tokens_details.audio_tokens ?? 0)} / {fmt(s?.sessionTotal.output_tokens_details.text_tokens ?? 0)}</span></div>
      <div className="metric"><span className="metric-label">最近段增量</span><span className="metric-value">+{fmt(s?.lastDelta.total_tokens ?? 0)}</span></div>
      <div className="metric"><span className="metric-label">全局累计</span><span className="metric-value">{fmt(s?.globalTotal.total_tokens ?? 0)}</span></div>
      <div className="metric"><span className="metric-label">首字延迟</span><span className="metric-value">{firstDeltaLatencyMs === null ? '—' : `${firstDeltaLatencyMs} ms`}</span></div>
      <div className="metric"><span className="metric-label">会话时长</span><span className="metric-value">{mm}:{ss}</span></div>
      <div className="metric-note">参考系数：输入音频 ~7.4 token/s · 输出音频 ~12.5 token/s（spec §6.4）</div>
    </section>
  );
}
