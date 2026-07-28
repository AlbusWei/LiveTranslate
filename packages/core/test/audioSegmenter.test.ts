import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AudioSegmenter } from '../src/session/audioSegmenter';
import { normalizeServerEvent } from '../src/protocol/normalize';
import { base64ToBytes } from '../src/audio/base64';
import type { ServerEvent } from '../src/protocol/types';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readJsonl = (f: string): ServerEvent[] =>
  readFileSync(join(FIX, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ServerEvent);

describe('AudioSegmenter', () => {
  it('concatenates audio-delta bytes per responseId and finalizes on response-done', () => {
    const done: Array<{ responseId: string; pcm: Uint8Array }> = [];
    const seg = new AudioSegmenter((responseId, pcm) => done.push({ responseId, pcm }));
    for (const raw of readJsonl('audio-turn.jsonl')) {
      const n = normalizeServerEvent(raw);
      if (n) seg.apply(n);
    }
    expect(done.length).toBe(1);
    expect(done[0]!.responseId).toBe('resp_MlgY53L3GmUfaCHIxXiHh');
    const d1 = base64ToBytes('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const d2 = base64ToBytes('AdaB2YHlwfIF/bMDfws/Fx8ffyH/J38vvzS/NH8yvzW/Mn8yPyk/In8YPxB/CXcBzv9Z+lH0wfBh8eHvIfCR8rn5');
    expect(done[0]!.pcm.length).toBe(d1.length + d2.length);
    expect(done[0]!.pcm.slice(d1.length)).toEqual(d2);
  });

  it('interleaved responses are kept apart', () => {
    const done: string[] = [];
    const seg = new AudioSegmenter((responseId) => done.push(responseId));
    seg.apply({ kind: 'audio-delta', responseId: 'rA', base64: 'AAAA' });
    seg.apply({ kind: 'audio-delta', responseId: 'rB', base64: 'BBBB' });
    seg.apply({ kind: 'audio-delta', responseId: 'rA', base64: 'CCCC' });
    seg.apply({ kind: 'response-done', responseId: 'rA', usage: null });
    seg.apply({ kind: 'response-done', responseId: 'rB', usage: null });
    expect(done).toEqual(['rA', 'rB']);
  });

  it('response-done without any audio (text-only turn) does not emit', () => {
    const done: string[] = [];
    const seg = new AudioSegmenter((responseId) => done.push(responseId));
    seg.apply({ kind: 'response-done', responseId: 'rText', usage: null });
    expect(done).toEqual([]);
  });
});
