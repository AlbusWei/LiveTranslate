import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerEvent, Usage } from '../src/protocol/types';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readJson = <T>(f: string): T => JSON.parse(readFileSync(join(FIX, f), 'utf8')) as T;
const readJsonl = (f: string): ServerEvent[] =>
  readFileSync(join(FIX, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ServerEvent);

describe('real protocol fixtures', () => {
  it('session.created carries default server config', () => {
    const ev = readJson<ServerEvent>('session-created.json');
    expect(ev.type).toBe('session.created');
    const session = (ev as ServerEvent & { session: Record<string, unknown> }).session;
    expect(session.voice).toBe('Tina');
    expect(session.sample_rate).toBe(16000);
  });

  it('text-turn contains full response lifecycle ending with session.finished', () => {
    const evs = readJsonl('text-turn.jsonl');
    const types = evs.map((e) => e.type);
    expect(types[0]).toBe('session.created');
    expect(types).toContain('response.created');
    expect(types).toContain('response.text.text');
    expect(types).toContain('response.done');
    expect(types[types.length - 1]).toBe('session.finished');
  });

  it('text/stash are dual full-refresh fields (stash retract sample present)', () => {
    const evs = readJsonl('text-turn.jsonl');
    const asr = evs.filter((e) => e.type === 'conversation.item.input_audio_transcription.text') as Array<
      ServerEvent & { text: string; stash: string }
    >;
    // 真实回撤样本：stash "今天。" 之后被 "今天天气" 覆盖（句号被回撤）
    expect(asr.map((e) => e.stash)).toEqual(['今天', '今天。', '今天天气']);
    expect(asr.every((e) => e.text === '')).toBe(true);
  });

  it('usage-sequence is session-cumulative (monotonic totals)', () => {
    const seq = readJson<Usage[]>('usage-sequence.json');
    expect(seq.length).toBe(4);
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]!.total_tokens).toBeGreaterThan(seq[i - 1]!.total_tokens);
      expect(seq[i]!.input_tokens_details.audio_tokens).toBeGreaterThan(seq[i - 1]!.input_tokens_details.audio_tokens);
    }
  });

  it('audio-turn carries audio.delta with base64 payload and audio usage', () => {
    const evs = readJsonl('audio-turn.jsonl');
    const deltas = evs.filter((e) => e.type === 'response.audio.delta') as Array<ServerEvent & { delta: string }>;
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas[0]!.delta.length % 4).toBe(0);
    const done = evs.find((e) => e.type === 'response.done') as ServerEvent & {
      response: { usage: Usage };
    };
    expect(done.response.usage.output_tokens_details.audio_tokens).toBe(51);
  });
});
