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

  it('rejects immediately if signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already aborted'));
    await expect(sleep(100, controller.signal)).rejects.toThrow('already aborted');
  });

  it('rejects when signal is aborted mid-sleep', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = sleep(1000, controller.signal);
    vi.advanceTimersByTime(100);
    controller.abort(new Error('cancelled'));
    await expect(promise).rejects.toThrow('cancelled');
    vi.useRealTimers();
  });
});
