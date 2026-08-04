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

  it('does NOT settle on a terminal verdict that predates the write', async () => {
    // The reported bug: apply --wait returned settled:true in ~0.6s while
    // naming the PREVIOUS revision. The first poll lands before the platform
    // has re-reconciled, so `terminal` is still the last operation's verdict.
    const stale = {
      container: {
        status_details: status({ summary: 'ready', operation: { state: 'succeeded', terminal: true } }),
        current_revision: 'todo-00002',
        deployment_count: 2,
      },
      url: null,
    };
    const fresh = {
      container: {
        status_details: status({
          summary: 'ready',
          observed_at: '2026-08-04T10:05:00+00:00',
          operation: { state: 'succeeded', terminal: true },
        }),
        current_revision: 'todo-00003',
        deployment_count: 3,
      },
      url: 'https://x.danubedata.run',
    };
    const { api } = apiReturning(stale, stale, fresh);

    const promise = waitForTerminal(api, 'abc', {
      baseline: { observedAt: '2026-08-04T10:00:00+00:00', currentRevision: 'todo-00002', deploymentCount: 2 },
    });
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await promise;

    expect(result.settled).toBe(true);
    expect(result.sawFreshObservation).toBe(true);
    // The new revision, not the one that was already serving.
    expect(result.targetRevision).toBe('todo-00003');
    expect(result.waitedMs).toBeGreaterThan(0);
  });

  it('reports fresh_observation false when it never sees the platform re-observe', async () => {
    const stale = {
      container: {
        status_details: status({ summary: 'ready', operation: { state: 'succeeded', terminal: true } }),
        current_revision: 'todo-00002',
        deployment_count: 2,
      },
      url: null,
    };
    const { api } = apiReturning(stale);

    const promise = waitForTerminal(api, 'abc', {
      timeoutMs: 10_000,
      baseline: { observedAt: '2026-08-04T10:00:00+00:00', currentRevision: 'todo-00002', deploymentCount: 2 },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await promise;

    // Honest: terminal was true the whole time, but never about OUR change.
    expect(result.settled).toBe(false);
    expect(result.sawFreshObservation).toBe(false);
  });

  it('accepts a deployment_count change as evidence of a new observation', async () => {
    const { api } = apiReturning({
      container: {
        status_details: status({ summary: 'ready', operation: { state: 'succeeded', terminal: true } }),
        current_revision: 'todo-00002',
        deployment_count: 3,
      },
      url: null,
    });

    const result = await waitForTerminal(api, 'abc', {
      baseline: { observedAt: '2026-08-04T10:00:00+00:00', currentRevision: 'todo-00002', deploymentCount: 2 },
    });

    expect(result.settled).toBe(true);
  });

  it('settles on the first poll when there is no baseline (a create)', async () => {
    // A newly created container has no previous verdict to be confused with,
    // so the guard must not slow the common case down.
    const { api, get } = apiReturning({
      container: { status_details: status({ summary: 'ready', operation: { state: 'succeeded', terminal: true } }) },
      url: null,
    });

    const result = await waitForTerminal(api, 'abc');

    expect(result.settled).toBe(true);
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
