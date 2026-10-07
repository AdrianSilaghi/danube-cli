import { sleep } from './sleep.js';
import { UsageError } from './errors.js';
import { POLICY_UPDATING } from './bucket-policy.js';
import type { BucketPolicy } from '../types/api.js';

/** The platform applies a policy in the background; seconds, not milliseconds. */
export const POLL_INTERVAL_MS = 2_000;

export const DEFAULT_WAIT_TIMEOUT_MS = 60_000;

/** No poll is given longer than a request is normally given. */
export const POLL_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The last look at the policy starts at the ceiling, so it is given this long to
 * answer even though no time is left. A wait is therefore over within its
 * timeout plus this one second, however slow the server is.
 */
export const LAST_LOOK_MS = 1_000;

export interface PolicyWaitResult {
  /** False when the timeout elapsed first: the change is still being applied, and has not failed. */
  settled: boolean;
  /** The policy as last observed — the accepted one when it was never polled. */
  policy: BucketPolicy;
  waitedMs: number;
}

/**
 * Wait for a change to a bucket's policy to stop being applied.
 *
 * Stops at any status other than `updating`, and says so: `active` means no
 * change is being applied any more, which is not the same as the storage
 * gateway holding it — a change the gateway refused ends as `active` too. That
 * caveat belongs in what the caller tells the person; this only knows when to
 * stop asking.
 *
 * The timeout is a ceiling, not a suggestion. Each poll is told how long it has
 * (`fetchPolicy` gets it, and cuts the request there), so a poll still in flight
 * cannot hold the wait past it; the last look, made at the ceiling, gets
 * LAST_LOOK_MS. A poll the ceiling cut short is "not settled", not an error; a
 * poll that fails before it ends the wait with its error, because the caller
 * knows the change itself was accepted.
 *
 * `fetchPolicy` is passed in, rather than the client, so the caller's own error
 * mapping applies to the polls as well.
 */
export async function waitForPolicy(
  fetchPolicy: (timeoutMs: number) => Promise<BucketPolicy>,
  accepted: BucketPolicy,
  opts: { timeoutMs?: number } = {},
): Promise<PolicyWaitResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const startedAt = Date.now();
  const elapsed = (): number => Date.now() - startedAt;
  let policy = accepted;

  while (policy.status === POLICY_UPDATING) {
    const remaining = timeoutMs - elapsed();

    if (remaining <= 0) {
      return { settled: false, policy, waitedMs: elapsed() };
    }

    await sleep(Math.min(POLL_INTERVAL_MS, remaining));

    try {
      policy = await fetchPolicy(Math.min(Math.max(timeoutMs - elapsed(), LAST_LOOK_MS), POLL_REQUEST_TIMEOUT_MS));
    } catch (err) {
      if (elapsed() >= timeoutMs) return { settled: false, policy, waitedMs: elapsed() };
      throw err;
    }
  }

  return { settled: true, policy, waitedMs: elapsed() };
}

const WAIT_TIMEOUT = /^(\d+)([smh])?$/;
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3_600 };

/**
 * `--wait-timeout`: a bare number is SECONDS, and `90s`, `2m` and `1h` are read
 * as the same flag on `rapids` reads them. Not `lib/duration.ts`: there a bare
 * number is milliseconds, which would turn `--wait-timeout 90` into a tenth of
 * a second.
 */
export function parseWaitTimeout(value: string): number {
  const match = WAIT_TIMEOUT.exec(value.trim());
  const seconds = match ? Number(match[1]) * UNIT_SECONDS[match[2] ?? 's']! : 0;

  if (seconds === 0) {
    throw new UsageError(
      `Invalid --wait-timeout '${value}': give a number of seconds above zero (90), or a duration such as 90s, 2m or 1h.`,
    );
  }

  return seconds * 1_000;
}
