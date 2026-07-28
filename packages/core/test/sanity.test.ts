import { describe, it, expect } from 'vitest';
import { CORE_VERSION } from '../src/index';

describe('workspace sanity', () => {
  it('core package resolves', () => {
    expect(CORE_VERSION).toBe('0.1.0');
  });
});
