import { describe, expect, it } from 'vitest';
import { buildMeetingMarkdown, buildMeetingTxt, type MeetingTurnExport } from '../src/meeting/meetingExport';

const turns: MeetingTurnExport[] = [
  {
    speaker: 'Alice',
    sourceText: '今天天气很好，我们一起去公园散步。',
    targetText: "The weather is very nice today, let's go for a walk in the park together.  ", // 真实译文带尾部空格，导出应 trim
    sourceLang: 'zh',
  },
  { speaker: 'Bob', sourceText: 'Good idea.', targetText: '好主意。', sourceLang: 'en' },
];

describe('buildMeetingMarkdown (spec 5.4 双语导出)', () => {
  it('renders header, roster and per-speaker bilingual blocks', () => {
    const md = buildMeetingMarkdown(
      { roster: ['Alice', 'Bob'], targetLanguage: 'en', createdAtIso: '2026-07-28T02:00:00.000Z' },
      turns,
    );
    expect(md).toBe([
      '# 会议记录 2026-07-28T02:00:00.000Z',
      '',
      '- 参会人：Alice、Bob',
      '- 目标语言：en',
      '',
      '## 发言',
      '',
      '### Alice（zh）',
      '',
      '今天天气很好，我们一起去公园散步。',
      '',
      "> The weather is very nice today, let's go for a walk in the park together.",
      '',
      '### Bob（en）',
      '',
      'Good idea.',
      '',
      '> 好主意。',
      '',
    ].join('\n'));
  });

  it('omits the language suffix when sourceLang is null', () => {
    const md = buildMeetingMarkdown(
      { roster: ['Alice'], targetLanguage: 'en', createdAtIso: '2026-07-28T02:00:00.000Z' },
      [{ speaker: 'Alice', sourceText: 'Hi.', targetText: '你好。', sourceLang: null }],
    );
    expect(md).toContain('### Alice\n');
    expect(md).not.toContain('### Alice（');
  });
});

describe('buildMeetingTxt', () => {
  it('renders speaker-prefixed bilingual pairs separated by blank lines', () => {
    expect(buildMeetingTxt(turns)).toBe(
      "[Alice] 今天天气很好，我们一起去公园散步。\nThe weather is very nice today, let's go for a walk in the park together.\n\n[Bob] Good idea.\n好主意。\n",
    );
  });
});
