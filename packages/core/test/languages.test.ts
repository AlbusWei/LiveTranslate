import { describe, it, expect } from 'vitest';
import { LANGUAGES, supportsAudioOutput } from '../src/i18n/languages';

describe('languages (spec 2.5: 60 languages, 29 with audio output)', () => {
  it('has 60 entries and exactly 29 audio-capable', () => {
    expect(LANGUAGES.length).toBe(60);
    expect(LANGUAGES.filter((l) => l.audio).length).toBe(29);
  });

  it('lookup helper works for known cases', () => {
    expect(supportsAudioOutput('en')).toBe(true);
    expect(supportsAudioOutput('zh')).toBe(true);
    expect(supportsAudioOutput('bo')).toBe(false);
  });
});
