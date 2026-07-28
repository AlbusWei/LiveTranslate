import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageMeter } from '../src/session/usageMeter';
import type { Usage } from '../src/protocol/types';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const SEQ = JSON.parse(readFileSync(join(FIX, 'usage-sequence.json'), 'utf8')) as Usage[];

describe('UsageMeter (P6: usage is session-cumulative, must diff)', () => {
  it('per-response delta from the real 169/436/697/972 sequence', () => {
    const m = new UsageMeter();
    const deltas = SEQ.map((u) => m.applyUsage(u).lastDelta.total_tokens);
    expect(deltas).toEqual([169, 267, 261, 275]);
  });

  it('session total equals the last cumulative value, not the sum of deltas doubled', () => {
    const m = new UsageMeter();
    for (const u of SEQ) m.applyUsage(u);
    const s = m.snapshot();
    expect(s.sessionTotal.total_tokens).toBe(972);
    expect(s.sessionTotal.input_tokens_details.audio_tokens).toBe(189);
    expect(s.sessionTotal.output_tokens_details.audio_tokens).toBe(327);
  });

  it('startNewSession() carries finished session totals into globalTotal (rotation, P13)', () => {
    const m = new UsageMeter();
    for (const u of SEQ) m.applyUsage(u);
    m.startNewSession();
    m.applyUsage(SEQ[0]!); // 新 session 重新从累积 169 开始
    const s = m.snapshot();
    expect(s.sessionTotal.total_tokens).toBe(169);
    expect(s.globalTotal.total_tokens).toBe(972 + 169);
  });

  it('null-safe: missing audio_tokens in output details treated as 0', () => {
    const m = new UsageMeter();
    const r = m.applyUsage({
      total_tokens: 118, input_tokens: 85, output_tokens: 33,
      input_tokens_details: { text_tokens: 50, audio_tokens: 35 },
      output_tokens_details: { text_tokens: 33 },
    });
    expect(r.lastDelta.output_tokens_details.audio_tokens).toBe(0);
  });
});
