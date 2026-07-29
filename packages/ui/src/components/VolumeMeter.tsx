export function VolumeMeter({ level }: { level: number }): JSX.Element {
  const pct = Math.min(100, Math.round(level * 300));
  return (
    <div style={{ height: '6px', background: 'var(--color-border)', borderRadius: '3px', overflow: 'hidden', marginTop: 'var(--space-2)' }}>
      <div style={{ height: '100%', width: `${pct}%`, background: pct > 5 ? 'var(--color-success)' : 'var(--color-border)', borderRadius: '3px', transition: 'width 80ms linear' }} />
    </div>
  );
}
