import { describe, expect, it } from 'vitest';
import { buildBilingualTxt, buildSrt, formatSrtTime } from '../src/file/srt';

describe('formatSrtTime', () => {
  it('formats hh:mm:ss,mmm', () => {
    expect(formatSrtTime(0)).toBe('00:00:00,000');
    expect(formatSrtTime(4600)).toBe('00:00:04,600');
    expect(formatSrtTime(65040)).toBe('00:01:05,040');
    expect(formatSrtTime(3600000 + 61001)).toBe('01:01:01,001');
  });
});

describe('buildSrt (spec 5.2，贴原时间轴)', () => {
  it('renders numbered cues with blank-line separators', () => {
    const srt = buildSrt([
      { startMs: 0, endMs: 4600, text: "The weather is very nice today, let's go for a walk in the park together." },
      { startMs: 4600, endMs: 11800, text: 'Second sentence.' },
    ]);
    expect(srt).toBe([
      '1',
      '00:00:00,000 --> 00:00:04,600',
      "The weather is very nice today, let's go for a walk in the park together.",
      '',
      '2',
      '00:00:04,600 --> 00:00:11,800',
      'Second sentence.',
      '',
    ].join('\n'));
  });
});

describe('buildBilingualTxt', () => {
  it('emits source + target per block', () => {
    expect(buildBilingualTxt([
      { sourceText: '今天天气很好，我们一起去公园散步。', targetText: 'The weather is very nice today.' },
      { sourceText: '第二句。', targetText: 'Second sentence.' },
    ])).toBe('今天天气很好，我们一起去公园散步。\nThe weather is very nice today.\n\n第二句。\nSecond sentence.\n');
  });
});
