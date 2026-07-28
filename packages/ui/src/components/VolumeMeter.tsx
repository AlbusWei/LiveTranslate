export function VolumeMeter({ level }: { level: number }): JSX.Element {
  const pct = Math.min(100, Math.round(level * 300)); // RMS 0.33 即满格，正常说话可见摆动
  return (
    <div className="volume-meter">
      <div className="volume-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}
