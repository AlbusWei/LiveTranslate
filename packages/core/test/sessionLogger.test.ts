import { describe, it, expect } from 'vitest';
import { SessionLogger, fnv1a } from '../src/session/sessionLogger';

function collect() {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
}

describe('fnv1a (canonical 32-bit vectors)', () => {
  // 公开已知值（FNV-1a 32bit 参考向量），非镜像实现断言
  it('matches published reference values', () => {
    expect(fnv1a('')).toBe('811c9dc5');
    expect(fnv1a('a')).toBe('e40c292c');
    expect(fnv1a('b')).toBe('e70c2de5');
    expect(fnv1a('hello')).toBe('4f9f2cab');
    expect(fnv1a('foobar')).toBe('bf9cf968');
  });
});

describe('SessionLogger (spec 6.6)', () => {
  it('writes {ts, dir, type, payload} JSONL lines', () => {
    const { lines, sink } = collect();
    const log = new SessionLogger({ sink, now: () => 1722153600000 });
    log.record('s2c', { type: 'session.created', session: { id: 'sess_1' } });
    expect(JSON.parse(lines[0]!)).toEqual({
      ts: 1722153600000, dir: 's2c', type: 'session.created',
      payload: { type: 'session.created', session: { id: 'sess_1' } },
    });
  });

  it('truncates input_audio_buffer.append base64 to <b64 len+fnv1a> by default', () => {
    const { lines, sink } = collect();
    const log = new SessionLogger({ sink, now: () => 0 });
    const audio = 'QUJDREVGRw=='.repeat(50);
    log.record('c2s', { type: 'input_audio_buffer.append', audio });
    const payload = (JSON.parse(lines[0]!) as { payload: { audio: string } }).payload;
    expect(payload.audio).toBe(`<b64 len=${audio.length} fnv1a=${fnv1a(audio)}>`);
  });

  it('truncates response.audio.delta the same way; keeps full payload when fullAudio=true', () => {
    const { lines, sink } = collect();
    const full = new SessionLogger({ sink, now: () => 0, fullAudio: true });
    full.record('s2c', { type: 'response.audio.delta', response_id: 'r1', delta: 'AAAA' });
    expect((JSON.parse(lines[0]!) as { payload: { delta: string } }).payload.delta).toBe('AAAA');
    const trunc = new SessionLogger({ sink, now: () => 0 });
    trunc.record('s2c', { type: 'response.audio.delta', response_id: 'r1', delta: 'AAAA' });
    expect((JSON.parse(lines[1]!) as { payload: { delta: string } }).payload.delta).toBe(`<b64 len=4 fnv1a=${fnv1a('AAAA')}>`);
  });

  it('records synthetic _lifecycle events (reconnect/downgrade/rotation)', () => {
    const { lines, sink } = collect();
    const log = new SessionLogger({ sink, now: () => 5 });
    log.lifecycle('reconnect', { attempt: 2, delayMs: 1000 });
    expect(JSON.parse(lines[0]!)).toEqual({
      ts: 5, dir: 'c2s', type: '_lifecycle',
      payload: { action: 'reconnect', attempt: 2, delayMs: 1000 },
    });
  });

  it('never logs Authorization/api key fields (secret scrub)', () => {
    const { lines, sink } = collect();
    const log = new SessionLogger({ sink, now: () => 0 });
    log.record('c2s', { type: '_lifecycle', authorization: 'Bearer sk-secret', apiKey: 'sk-secret', note: 'ok' });
    const payload = (JSON.parse(lines[0]!) as { payload: Record<string, unknown> }).payload;
    expect(payload.authorization).toBe('<redacted>');
    expect(payload.apiKey).toBe('<redacted>');
    expect(payload.note).toBe('ok');
  });
});
