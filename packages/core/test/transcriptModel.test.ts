import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TranscriptModel } from '../src/session/transcriptModel';
import { normalizeServerEvent } from '../src/protocol/normalize';
import type { ServerEvent } from '../src/protocol/types';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readJsonl = (f: string): ServerEvent[] =>
  readFileSync(join(FIX, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ServerEvent);

function feed(model: TranscriptModel, f: string): void {
  for (const ev of readJsonl(f)) {
    const n = normalizeServerEvent(ev);
    if (n) model.apply(n);
  }
}

describe('TranscriptModel', () => {
  it('replays the real text turn into one done segment with source and target', () => {
    const m = new TranscriptModel();
    feed(m, 'text-turn.jsonl');
    const segs = m.getSegments();
    expect(segs.length).toBe(1);
    const s = segs[0]!;
    expect(s.status).toBe('done');
    expect(s.seq).toBe(1);
    expect(s.responseId).toBe('resp_C7BkFOHX9LQHXjIc4RWPJ');
    expect(s.sourceText).toBe('今天天气很好，我们一起去公园散步。');
    expect(s.targetText).toBe("The weather is very nice today, let's go for a walk in the park together.  ");
    expect(s.sourceLang).toBe('zh');
    expect(s.emotion).toBe('neutral');
    expect(s.vadStartMs).toBe(0);
    expect(s.vadEndMs).toBe(4600);
    expect(s.usage?.total_tokens).toBe(118);
  });

  it('overwrite semantics: stash retract replaces the whole field, never appends (P4)', () => {
    const m = new TranscriptModel();
    m.apply({ kind: 'speech-started', itemId: 'i1', audioStartMs: 0 });
    m.apply({ kind: 'asr-delta', itemId: 'i1', text: '', stash: '今天。', language: 'zh', emotion: 'neutral' });
    m.apply({ kind: 'asr-delta', itemId: 'i1', text: '', stash: '今天天气', language: 'zh', emotion: 'neutral' });
    const s = m.getSegments()[0]!;
    expect(s.sourceStash).toBe('今天天气'); // 句号被回撤，不是 '今天。今天天气'
    expect(s.sourceText).toBe('');
  });

  it('translation-delta before speech-stopped binds to the current open segment', () => {
    const m = new TranscriptModel();
    m.apply({ kind: 'speech-started', itemId: 'i1', audioStartMs: 0 });
    m.apply({ kind: 'response-created', responseId: 'r1' });
    m.apply({ kind: 'translation-delta', responseId: 'r1', text: 'Hello', stash: ' wor' });
    const s = m.getSegments()[0]!;
    expect(s.responseId).toBe('r1');
    expect(s.targetText).toBe('Hello');
    expect(s.targetStash).toBe(' wor');
    expect(s.status).toBe('translating');
  });

  it('response-done fixes the segment and clears stash', () => {
    const m = new TranscriptModel();
    m.apply({ kind: 'speech-started', itemId: 'i1', audioStartMs: 0 });
    m.apply({ kind: 'response-created', responseId: 'r1' });
    m.apply({ kind: 'translation-delta', responseId: 'r1', text: '', stash: 'Hi' });
    m.apply({ kind: 'translation-done', responseId: 'r1', text: 'Hi there' });
    m.apply({ kind: 'response-done', responseId: 'r1', usage: null });
    const s = m.getSegments()[0]!;
    expect(s.status).toBe('done');
    expect(s.targetText).toBe('Hi there');
    expect(s.targetStash).toBe('');
  });

  it('markInterrupted() flags in-flight segments only (R3)', () => {
    const m = new TranscriptModel();
    m.apply({ kind: 'speech-started', itemId: 'i1', audioStartMs: 0 });
    m.apply({ kind: 'response-created', responseId: 'r1' });
    m.apply({ kind: 'translation-done', responseId: 'r1', text: 'done one' });
    m.apply({ kind: 'response-done', responseId: 'r1', usage: null });
    m.apply({ kind: 'speech-started', itemId: 'i2', audioStartMs: 5000 });
    m.apply({ kind: 'response-created', responseId: 'r2' });
    m.markInterrupted();
    const [a, b] = m.getSegments();
    expect(a!.status).toBe('done');
    expect(b!.status).toBe('interrupted');
  });

  it('audio turn: consecutive turns get increasing seq; listener fires on every change', () => {
    const m = new TranscriptModel();
    const snapshots: number[] = [];
    m.onChange(() => snapshots.push(m.getSegments().length));
    feed(m, 'audio-turn.jsonl');
    expect(m.getSegments()[0]!.seq).toBe(1);
    expect(snapshots.length).toBeGreaterThan(0);
  });
});
