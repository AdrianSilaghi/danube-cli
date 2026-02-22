import { describe, it, expect, vi } from 'vitest';
import { sleep } from '../src/lib/sleep.js';

describe('sleep', () => {
  it('resolves after the given ms', async () => {
    vi.useFakeTimers();
    const promise = sleep(100);
    vi.advanceTimersByTime(100);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});
