import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The wait is logic about time, so the clock is faked: `sleep` moves it forward
// and nothing really waits. Date.now() is the clock the wait reads.
let now = 0;
const sleeps: number[] = [];
vi.mock('../src/lib/sleep.js', () => ({
  sleep: vi.fn(async (ms: number) => {
    sleeps.push(ms);
    now += ms;
  }),
}));

const { waitForPolicy, parseWaitTimeout, POLL_INTERVAL_MS, DEFAULT_WAIT_TIMEOUT_MS, POLL_REQUEST_TIMEOUT_MS, LAST_LOOK_MS } = await import('../src/lib/wait-for-policy.js');
const { UsageError } = await import('../src/lib/errors.js');
import type { BucketPolicy } from '../src/types/api.js';

const policy = (status: string, statements: Record<string, unknown>[] = []): BucketPolicy => ({
  custom_policy_statements: statements,
  effective_policy: null,
  status,
});

/** A fetch that answers with each status in turn, then the last one for ever. */
const fetching = (...statuses: string[]) => {
  const fetchPolicy = vi.fn();
  statuses.forEach((s) => fetchPolicy.mockResolvedValueOnce(policy(s)));
  fetchPolicy.mockResolvedValue(policy(statuses[statuses.length - 1]!));
  return fetchPolicy;
};

describe('waitForPolicy', () => {
  beforeEach(() => {
    now = 0;
    sleeps.length = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('polls every two seconds and defaults to a minute', () => {
    expect(POLL_INTERVAL_MS).toBe(2_000);
    expect(DEFAULT_WAIT_TIMEOUT_MS).toBe(60_000);
  });

  it('lets a poll take 30 seconds at most, and the last look at least one', () => {
    expect(POLL_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(LAST_LOOK_MS).toBe(1_000);
  });

  it('does not poll at all when the accepted change is not updating', async () => {
    const fetchPolicy = fetching('active');

    const result = await waitForPolicy(fetchPolicy, policy('active'), { timeoutMs: 60_000 });

    expect(result.settled).toBe(true);
    expect(fetchPolicy).not.toHaveBeenCalled();
    expect(sleeps).toEqual([]);
  });

  it('polls until the status is no longer updating', async () => {
    const fetchPolicy = fetching('updating', 'updating', 'active');

    const result = await waitForPolicy(fetchPolicy, policy('updating'), { timeoutMs: 60_000 });

    expect(result.settled).toBe(true);
    expect(result.policy.status).toBe('active');
    expect(fetchPolicy).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([2_000, 2_000, 2_000]);
    expect(result.waitedMs).toBe(6_000);
  });

  it('stops at any status other than updating, not only active', async () => {
    const fetchPolicy = fetching('error');

    const result = await waitForPolicy(fetchPolicy, policy('updating'), { timeoutMs: 60_000 });

    expect(result.settled).toBe(true);
    expect(result.policy.status).toBe('error');
    expect(fetchPolicy).toHaveBeenCalledTimes(1);
  });

  it('hands back the latest document it saw, not the accepted one', async () => {
    const fetchPolicy = vi.fn().mockResolvedValue(policy('active', [{ Effect: 'Allow', Sid: 'later' }]));

    const result = await waitForPolicy(fetchPolicy, policy('updating', [{ Effect: 'Allow', Sid: 'earlier' }]), { timeoutMs: 60_000 });

    expect(result.policy.custom_policy_statements).toEqual([{ Effect: 'Allow', Sid: 'later' }]);
  });

  it('gives up at the timeout and says it did not settle', async () => {
    const fetchPolicy = fetching('updating');

    const result = await waitForPolicy(fetchPolicy, policy('updating'), { timeoutMs: 10_000 });

    expect(result.settled).toBe(false);
    expect(result.policy.status).toBe('updating');
    expect(result.waitedMs).toBe(10_000);
    expect(fetchPolicy).toHaveBeenCalledTimes(5);
    expect(sleeps).toEqual([2_000, 2_000, 2_000, 2_000, 2_000]);
  });

  it('makes its last poll at the deadline, not after it', async () => {
    const fetchPolicy = fetching('updating');

    await waitForPolicy(fetchPolicy, policy('updating'), { timeoutMs: 5_000 });

    // 2s + 2s + the 1s that is left: it never sleeps past the timeout.
    expect(sleeps).toEqual([2_000, 2_000, 1_000]);
    expect(fetchPolicy).toHaveBeenCalledTimes(3);
  });

  it('still looks once when the timeout is shorter than a poll interval', async () => {
    const fetchPolicy = fetching('updating');

    const result = await waitForPolicy(fetchPolicy, policy('updating'), { timeoutMs: 1_000 });

    expect(sleeps).toEqual([1_000]);
    expect(fetchPolicy).toHaveBeenCalledTimes(1);
    expect(result.settled).toBe(false);
  });

  it('settles on a poll that lands exactly on the deadline', async () => {
    const fetchPolicy = fetching('updating', 'updating', 'active');

    const result = await waitForPolicy(fetchPolicy, policy('updating'), { timeoutMs: 6_000 });

    expect(result.settled).toBe(true);
    expect(fetchPolicy).toHaveBeenCalledTimes(3);
  });

  it('waits a minute by default', async () => {
    const fetchPolicy = fetching('updating');

    const result = await waitForPolicy(fetchPolicy, policy('updating'));

    expect(result.settled).toBe(false);
    expect(result.waitedMs).toBe(60_000);
    expect(fetchPolicy).toHaveBeenCalledTimes(30);
  });

  describe('the ceiling is a ceiling', () => {
    it('gives each poll the time that is left, so none can run past it', async () => {
      const fetchPolicy = fetching('updating');

      await waitForPolicy(fetchPolicy, policy('updating'), { timeoutMs: 10_000 });

      // The last one starts at the ceiling itself, and is given the one second of the last look.
      expect(fetchPolicy.mock.calls.map((c) => c[0])).toEqual([8_000, 6_000, 4_000, 2_000, 1_000]);
    });

    it('never gives a poll more than 30 seconds, however long the ceiling is', async () => {
      const fetchPolicy = fetching('active');

      await waitForPolicy(fetchPolicy, policy('updating'), { timeoutMs: 10 * 60_000 });

      expect(fetchPolicy).toHaveBeenCalledWith(30_000);
    });

    it('gives the last look a second even when the ceiling is already used up by waiting for it', async () => {
      const fetchPolicy = fetching('updating');

      await waitForPolicy(fetchPolicy, policy('updating'), { timeoutMs: 1_500 });

      expect(sleeps).toEqual([1_500]);
      expect(fetchPolicy).toHaveBeenCalledTimes(1);
      expect(fetchPolicy).toHaveBeenCalledWith(1_000);
    });

    it('ends as "not settled", not as an error, when the ceiling is what cut a poll short', async () => {
      const cutByTheCeiling = vi.fn(async (budgetMs: number) => {
        now += budgetMs;
        throw new Error(`Request timed out after ${budgetMs}ms: GET /policy`);
      });

      const result = await waitForPolicy(cutByTheCeiling, policy('updating'), { timeoutMs: 5_000 });

      expect(result.settled).toBe(false);
      expect(result.waitedMs).toBe(5_000);
      // Nothing newer was seen, so the accepted document is the one it hands back.
      expect(result.policy.status).toBe('updating');
      expect(cutByTheCeiling).toHaveBeenCalledTimes(1);
    });

    it('still lets an error through when the ceiling is not what ended the poll', async () => {
      const failedEarly = vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      });

      await expect(waitForPolicy(failedEarly, policy('updating'), { timeoutMs: 60_000 })).rejects.toThrow('ECONNREFUSED');
    });
  });

  it('stops polling when a poll fails, and lets the error through', async () => {
    const boom = new Error('server on fire');
    const fetchPolicy = vi.fn().mockResolvedValueOnce(policy('updating')).mockRejectedValueOnce(boom);

    await expect(waitForPolicy(fetchPolicy, policy('updating'), { timeoutMs: 60_000 })).rejects.toBe(boom);

    expect(fetchPolicy).toHaveBeenCalledTimes(2);
  });
});

describe('parseWaitTimeout', () => {
  it.each([
    ['90', 90_000],
    ['90s', 90_000],
    ['2m', 120_000],
    ['1h', 3_600_000],
    [' 30 ', 30_000],
    ['1', 1_000],
  ])('reads %j as %d ms: a bare number is seconds', (text, ms) => {
    expect(parseWaitTimeout(text)).toBe(ms);
  });

  it.each(['0', '0s', '0m', '', 'abc', '-5', '1.5', '10x', '500ms', '2 m'])(
    'refuses %j with a message that names the flag and shows what is accepted',
    (text) => {
      const attempt = () => parseWaitTimeout(text);

      expect(attempt).toThrow(UsageError);
      expect(attempt).toThrow(/--wait-timeout/);
      expect(attempt).toThrow(/seconds/);
    },
  );
});
