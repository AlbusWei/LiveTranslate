import { describe, expect, it } from 'vitest';
import { ROTATE_INPUT_TOKENS, ROTATE_PAUSE_MS, shouldRotate } from '../src/session/rotationPolicy';

describe('shouldRotate (spec 5.4 / P13)', () => {
  it('keeps the session at exactly 40000 input tokens', () => {
    expect(shouldRotate({ sessionInputTokens: ROTATE_INPUT_TOKENS, hadError: false, pausedSinceMs: null, now: 0 })).toBeNull();
  });

  it('rotates above 40000 input tokens', () => {
    expect(shouldRotate({ sessionInputTokens: ROTATE_INPUT_TOKENS + 1, hadError: false, pausedSinceMs: null, now: 0 })).toBe('tokens');
  });

  it('error takes precedence over token count', () => {
    expect(shouldRotate({ sessionInputTokens: 50000, hadError: true, pausedSinceMs: null, now: 0 })).toBe('error');
  });

  it('rotates after a pause longer than 10 minutes', () => {
    expect(shouldRotate({ sessionInputTokens: 0, hadError: false, pausedSinceMs: 0, now: ROTATE_PAUSE_MS + 1 })).toBe('paused');
  });

  it('keeps the session for short pauses', () => {
    expect(shouldRotate({ sessionInputTokens: 0, hadError: false, pausedSinceMs: 0, now: ROTATE_PAUSE_MS - 1 })).toBeNull();
  });
});
