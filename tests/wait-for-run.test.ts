import { describe, it, expect, vi } from 'vitest';

// Polling is the behaviour under test; actually sleeping between polls would
// make the suite take minutes to assert something that is purely logical.
vi.mock('../src/lib/sleep.js', () => ({ sleep: vi.fn(() => Promise.resolve()) }));

const { waitForRun, DEFAULT_WAIT_TIMEOUT_MS } = await import('../src/lib/wait-for-run.js');
import type { ApiClient } from '../src/lib/api-client.js';
import type { ServerlessRun } from '../src/types/api.js';

const makeRun = (overrides: Partial<ServerlessRun> = {}): ServerlessRun => ({
  id: 'run-1',
  container_id: 'c-1',
  status: 'running',
  terminal: false,
  command: null,
  image: 'nginx:latest',
  env_keys: [],
  timeout_seconds: 900,
  exit_code: null,
  message: null,
  created_at: '2026-09-16T00:00:00Z',
  started_at: '2026-09-16T00:00:01Z',
  finished_at: null,
  duration_seconds: null,
  ...overrides,
});

const apiReturning = (...runs: ServerlessRun[]) => {
  const get = vi.fn();
  runs.forEach((r) => get.mockResolvedValueOnce({ data: r }));
  get.mockResolvedValue({ data: runs[runs.length - 1] });
  return { api: { get } as unknown as ApiClient, get };
};

describe('waitForRun', () => {
  it('returns immediately when the first poll is already terminal', async () => {
    const { api, get } = apiReturning(makeRun({ status: 'succeeded', terminal: true }));

    const result = await waitForRun(api, 'c-1', 'run-1');

    expect(result.settled).toBe(true);
    expect(result.run.status).toBe('succeeded');
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/api/v1/serverless/c-1/runs/run-1');
  });

  it('keeps polling while not terminal, then settles', async () => {
    const { api, get } = apiReturning(
      makeRun({ status: 'running', terminal: false }),
      makeRun({ status: 'running', terminal: false }),
      makeRun({ status: 'failed', terminal: true, exit_code: 1 }),
    );

    const result = await waitForRun(api, 'c-1', 'run-1');

    expect(result.settled).toBe(true);
    expect(result.run.status).toBe('failed');
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('reports not settled when the timeout is shorter than one poll interval', async () => {
    // The look-ahead check (`elapsed + POLL_INTERVAL_MS > timeoutMs`) trips on
    // the very first poll whenever timeoutMs is under the 3s poll interval —
    // deterministic, no reliance on real elapsed wall-clock time.
    const { api, get } = apiReturning(makeRun({ status: 'running', terminal: false }));

    const result = await waitForRun(api, 'c-1', 'run-1', { timeoutMs: 100 });

    expect(result.settled).toBe(false);
    expect(result.run.status).toBe('running');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('defaults to a 10 minute ceiling', () => {
    expect(DEFAULT_WAIT_TIMEOUT_MS).toBe(10 * 60_000);
  });

  it('calls onTick on every poll, including the terminal one', async () => {
    const { api } = apiReturning(
      makeRun({ status: 'running', terminal: false }),
      makeRun({ status: 'succeeded', terminal: true }),
    );
    const onTick = vi.fn();

    await waitForRun(api, 'c-1', 'run-1', { onTick });

    expect(onTick).toHaveBeenCalledTimes(2);
    expect(onTick).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'succeeded' }));
  });

  it('awaits an async onTick before deciding terminality', async () => {
    const { api } = apiReturning(makeRun({ status: 'succeeded', terminal: true }));
    const order: string[] = [];
    const onTick = vi.fn(async () => {
      order.push('tick');
    });

    await waitForRun(api, 'c-1', 'run-1', { onTick });

    expect(order).toEqual(['tick']);
  });

  it('works with no onTick supplied at all', async () => {
    const { api } = apiReturning(makeRun({ status: 'succeeded', terminal: true }));

    await expect(waitForRun(api, 'c-1', 'run-1')).resolves.toMatchObject({ settled: true });
  });
});
