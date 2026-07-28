export interface MeetingTurnExport {
  speaker: string;
  sourceText: string;
  targetText: string;
  sourceLang: string | null;
}

export interface MeetingMeta {
  roster: string[];
  targetLanguage: string;
  createdAtIso: string; // new Date(created_at).toISOString()
}

export function buildMeetingMarkdown(meta: MeetingMeta, turns: MeetingTurnExport[]): string {
  const lines: string[] = [
    `# 会议记录 ${meta.createdAtIso}`,
    '',
    `- 参会人：${meta.roster.join('、')}`,
    `- 目标语言：${meta.targetLanguage}`,
    '',
    '## 发言',
    '',
  ];
  for (const t of turns) {
    lines.push(
      `### ${t.speaker}${t.sourceLang ? `（${t.sourceLang}）` : ''}`,
      '',
      t.sourceText.trim(),
      '',
      `> ${t.targetText.trim()}`,
      '',
    );
  }
  return lines.join('\n');
}

export function buildMeetingTxt(turns: MeetingTurnExport[]): string {
  return turns.map((t) => `[${t.speaker}] ${t.sourceText.trim()}\n${t.targetText.trim()}\n`).join('\n');
}
