export interface SrtCue {
  startMs: number;
  endMs: number;
  text: string;
}

export function formatSrtTime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  const pad = (n: number, w: number): string => String(n).padStart(w, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(milli, 3)}`;
}

export function buildSrt(cues: SrtCue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${formatSrtTime(c.startMs)} --> ${formatSrtTime(c.endMs)}\n${c.text}\n`)
    .join('\n');
}

export function buildBilingualTxt(entries: Array<{ sourceText: string; targetText: string }>): string {
  return entries.map((e) => `${e.sourceText}\n${e.targetText}\n`).join('\n');
}
