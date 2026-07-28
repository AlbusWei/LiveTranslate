import { describe, it, expect, vi } from 'vitest';
import { Emitter } from '../src/protocol/emitter';

type TestMap = { foo: number; bar: string };

describe('Emitter', () => {
  it('delivers payload to subscribers of the same key only', () => {
    const em = new Emitter<TestMap>();
    const onFoo = vi.fn();
    const onBar = vi.fn();
    em.on('foo', onFoo);
    em.on('bar', onBar);
    em.emit('foo', 42);
    expect(onFoo).toHaveBeenCalledWith(42);
    expect(onBar).not.toHaveBeenCalled();
  });

  it('unsubscribe function removes the handler', () => {
    const em = new Emitter<TestMap>();
    const cb = vi.fn();
    const off = em.on('foo', cb);
    off();
    em.emit('foo', 1);
    expect(cb).not.toHaveBeenCalled();
  });

  it('clear() removes all handlers', () => {
    const em = new Emitter<TestMap>();
    const cb = vi.fn();
    em.on('bar', cb);
    em.clear();
    em.emit('bar', 'x');
    expect(cb).not.toHaveBeenCalled();
  });
});
