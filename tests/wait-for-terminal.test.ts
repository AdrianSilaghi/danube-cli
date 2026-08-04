import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitForTerminal } from '../src/lib/wait-for-terminal.js';
import type { ApiClient } from '../src/lib/api-client.js';

/** Minimal status_details builder — only the fields the poller reads. */
const status = (over: Record<string, unknown> = {}) => ({
  summary: 'in_progress',
  health: 'unknown',
  observed_at: '2026-08-04T10:00:00+00:00',
  stale: false,
  operation: { state: 'running', terminal: false },
  error: null,
  ...over,
});

const apiReturning = (...responses: unknown[]) => {
  const get = vi.fn();
  responses.forEach((r) => get.mockResolvedValueOnce(r));
  // Repeat the last response for any further polls.
  get.mockResolvedValue(responses[responses.length - 1]);
  return { api: { get } as unknown as ApiClient, get };
};

describe('waitForTerminal', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns immediately when the first poll is already terminal', async () => {
    const { api, get } = apiReturning({
      container: { status_details: status({ summary: 'ready', operation: { state: 'succeeded', terminal: true } }) },
      url: 'https://x.danubedata.run',
    });

    const result = await waitForTerminal(api, 'abc');

    expect(result.settled).toBe(true);
    expect(result.status?.summary).toBe('ready');
    expect(result.url).toBe('https://x.danubedata.run');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('keeps polling while terminal is false, then settles', async () => {
    const { api, get } = apiReturning(
      { container: { status_details: status() }, url: null },
      { container: { status_details: status() }, url: null },
      {
        container: { status_details: status({ summary: 'failed', operation: { state: 'failed', terminal: true } }) },
        url: null,
      },
    );

    const promise = waitForTerminal(api, 'abc');
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;

    expect(result.settled).toBe(true);
    expect(result.status?.summary).toBe('failed');
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('treats degraded as terminal — an old revision is still serving, so stop waiting', async () => {
    const { api } = apiReturning({
      container: {
        status_details: status({
          summary: 'degraded',
          health: 'degraded',
          operation: { state: 'failed', terminal: true },
        }),
      },
      url: 'https://x.danubedata.run',
    });

    const result = await waitForTerminal(api, 'abc');

    expect(result.settled).toBe(true);
    expect(result.status?.summary).toBe('degraded');
  });

  it('does NOT settle on health unknown — that is a rollout in progress, not a verdict', async () => {
    const { api } = apiReturning({
      container: { status_details: status({ health: 'unknown', operation: { state: 'running', terminal: false } }) },
      url: null,
    });

    const promise = waitForTerminal(api, 'abc', { timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;

    expect(result.settled).toBe(false);
  });

  it('gives up at the timeout and reports not-settled rather than inventing a verdict', async () => {
    const { api } = apiReturning({ container: { status_details: status() }, url: null });

    const promise = waitForTerminal(api, 'abc', { timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await promise;

    expect(result.settled).toBe(false);
    expect(result.status?.summary).toBe('in_progress');
  });

  it('bails out when the platform does not report status_details at all', async () => {
    const { api, get } = apiReturning({ container: { status: 'pending' }, url: null });

    const result = await waitForTerminal(api, 'abc', { timeoutMs: 60_000 });

    // One poll, not a spin until timeout on a field that will never appear.
    expect(result.settled).toBe(false);
    expect(result.status).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('reports each poll through onTick', async () => {
    const { api } = apiReturning(
      { container: { status_details: status() }, url: null },
      {
        container: { status_details: status({ summary: 'ready', operation: { state: 'succeeded', terminal: true } }) },
        url: null,
      },
    );
    const seen: (string | undefined)[] = [];

    const promise = waitForTerminal(api, 'abc', { onTick: (s) => seen.push(s?.summary) });
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;

    expect(seen).toEqual(['in_progress', 'ready']);
  });
});
