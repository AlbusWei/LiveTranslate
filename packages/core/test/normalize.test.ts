import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeServerEvent } from '../src/protocol/normalize';
import type { NormalizedEvent, ServerEvent } from '../src/protocol/types';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readJsonl = (f: string): ServerEvent[] =>
  readFileSync(join(FIX, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ServerEvent);
const normalizeAll = (f: string): NormalizedEvent[] =>
  readJsonl(f).map(normalizeServerEvent).filter((e): e is NormalizedEvent => e !== null);

describe('normalizeServerEvent (driven by real fixtures)', () => {
  it('maps text-turn.jsonl to the expected kind sequence (content_part.done is dropped)', () => {
    const kinds = normalizeAll('text-turn.jsonl').map((e) => e.kind);
    expect(kinds).toEqual([
      'session-created', 'session-updated', 'speech-started',
      'asr-delta', 'asr-delta', 'asr-delta',
      'response-created', 'translation-delta', 'translation-delta', 'translation-delta',
      'speech-stopped', 'translation-done', 'asr-completed',
      'response-done', 'session-finished',
    ]);
  });

  it('asr-delta keeps text/stash/language/emotion (incl. real stash retract)', () => {
    const asr = normalizeAll('text-turn.jsonl').filter((e) => e.kind === 'asr-delta');
    expect(asr.map((e) => e.kind === 'asr-delta' && e.stash)).toEqual(['今天', '今天。', '今天天气']);
    const first = asr[0]!;
    if (first.kind !== 'asr-delta') throw new Error('unreachable');
    expect(first.language).toBe('zh');
    expect(first.emotion).toBe('neutral');
  });

  it('translation-done carries the final text; response-done carries cumulative usage', () => {
    const evs = normalizeAll('text-turn.jsonl');
    const done = evs.find((e) => e.kind === 'translation-done');
    if (done?.kind !== 'translation-done') throw new Error('missing translation-done');
    expect(done.text).toBe("The weather is very nice today, let's go for a walk in the park together.  ");
    const rd = evs.find((e) => e.kind === 'response-done');
    if (rd?.kind !== 'response-done') throw new Error('missing response-done');
    expect(rd.usage?.total_tokens).toBe(118);
  });

  it('audio modality: audio_transcript.text → translation-delta; audio.delta → audio-delta; audio.done is dropped', () => {
    const evs = normalizeAll('audio-turn.jsonl');
    const kinds = evs.map((e) => e.kind);
    expect(kinds).toEqual([
      'speech-started', 'response-created', 'translation-delta',
      'audio-delta', 'audio-delta', 'translation-done',
      'speech-stopped', 'response-done',
    ]);
    const delta = evs.find((e) => e.kind === 'audio-delta');
    if (delta?.kind !== 'audio-delta') throw new Error('missing audio-delta');
    expect(delta.responseId).toBe('resp_MlgY53L3GmUfaCHIxXiHh');
    expect(delta.base64.length % 4).toBe(0);
  });

  it('error event → server-error; unknown type → null', () => {
    const err = normalizeServerEvent({ type: 'error', error: { code: 'invalid_request', message: 'bad' } });
    expect(err).toEqual({
      kind: 'server-error', code: 'invalid_request', message: 'bad',
      raw: { type: 'error', error: { code: 'invalid_request', message: 'bad' } },
    });
    expect(normalizeServerEvent({ type: 'rate_limits.updated' })).toBeNull();
  });
});
