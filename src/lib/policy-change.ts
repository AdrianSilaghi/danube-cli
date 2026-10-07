import chalk from 'chalk';
import type { ApiClient } from './api-client.js';
import { isJsonMode, jsonEnvelope } from './json-mode.js';
import { statusColor } from './output.js';
import { ApiError, NotAuthenticatedError, UsageError } from './errors.js';
import { policyApi, policyPath, POLICY_UPDATING } from './bucket-policy.js';
import { waitForPolicy, parseWaitTimeout, DEFAULT_WAIT_TIMEOUT_MS, type PolicyWaitResult } from './wait-for-policy.js';
import { CLIENT_WAIT_TIMEOUT_EXIT_CODE } from './report-run.js';
import type { BucketPolicy, StorageBucket } from '../types/api.js';

/**
 * What `storage policy set` and `storage policy grant` do once the API has
 * accepted a change: report it, and — with `--wait` — wait for it to stop being
 * applied and report that. Shared so both describe the same wait in the same
 * words, as report-wait.ts does for the rapids commands.
 */

export interface WaitFlags {
  wait?: boolean;
  waitTimeout?: string;
}

/**
 * How long to wait, or null for not waiting. Read before anything is sent, so a
 * mistyped timeout cannot leave a change made and its wait refused.
 */
export function waitCeiling(flags: WaitFlags): number | null {
  if (flags.waitTimeout !== undefined && !flags.wait) {
    throw new UsageError('--wait-timeout needs --wait.');
  }

  if (!flags.wait) return null;

  return flags.waitTimeout === undefined ? DEFAULT_WAIT_TIMEOUT_MS : parseWaitTimeout(flags.waitTimeout);
}

/** A change the API accepted, and what to tell the person about it. */
export interface Change {
  api: ApiClient;
  bucket: StorageBucket;
  /**
   * What the API answered. It is a policy document, but the change is made by the
   * time it arrives, so a body that is empty or has no status is reported as what
   * it is, not as a crash.
   */
  accepted: BucketPolicy | null;
  /** What the change did, in words: printed before the status, and before any wait. */
  describe: () => void;
  /** How long to wait, or null for not waiting. */
  ceilingMs: number | null;
  /** What the names on the command line resolved to: the ids the JSON says it acted on. */
  meta: Record<string, unknown>;
}

/** What `updating` means, in the words the API's own documentation uses. */
const ON_ITS_WAY = 'The change is saved and on its way to the storage gateway.';

/** Where a wait starts when the answer did not say: on its way, which is what a 202 means. */
const ASSUMED_UPDATING: BucketPolicy = { custom_policy_statements: [], effective_policy: null, status: POLICY_UPDATING };

const seconds = (ms: number): number => Math.round(ms / 1000);

const checkLater = (bucketName: string): string => `danube storage policy get ${bucketName} shows what is stored.`;

const hasStatus = (accepted: BucketPolicy | null): accepted is BucketPolicy => typeof accepted?.status === 'string';

function printAccepted(bucketName: string, accepted: BucketPolicy | null): void {
  if (!hasStatus(accepted)) {
    console.log('The change was accepted; the answer carried no status.');
    console.log(chalk.dim(checkLater(bucketName)));
    return;
  }

  console.log(`Status: ${statusColor(accepted.status)}`);
  if (accepted.status === POLICY_UPDATING) console.log(`${ON_ITS_WAY} Add --wait to wait until it is no longer being applied.`);
  console.log(chalk.dim(checkLater(bucketName)));
}

/**
 * `active` is reported for what it is: no change is being applied any more. It
 * is NOT said to mean the gateway holds the change, because a change the
 * gateway refused ends as `active` too.
 */
function printSettled(bucketName: string, policy: BucketPolicy): void {
  if (policy.status === 'active') {
    console.log(`Status: ${statusColor('active')}. The change is no longer being applied.`);
    console.log('That does not prove the storage gateway holds it: a change the gateway refused also ends as active.');
    console.log(chalk.dim(checkLater(bucketName)));
    return;
  }

  console.error(chalk.red(`Bucket ${bucketName} is now in status '${policy.status}', so the change may not have been applied.`));
  console.error(chalk.dim(`danube storage buckets get ${bucketName} shows the bucket.`));
}

function printTimeout(bucketName: string, waitedMs: number): void {
  console.error(chalk.yellow(
    `Still updating after ${seconds(waitedMs)}s: the client gave up waiting. The change was accepted and is still being applied; it has not failed.`,
  ));
  console.error(chalk.dim(`Check later: danube storage policy get ${bucketName}`));
}

/**
 * The document last seen, over what only the accepted answer carries (a grant's
 * added statements and warnings): what the polls saw is newer, and wins.
 */
function latestDocument(accepted: BucketPolicy | null, observed: BucketPolicy | null): BucketPolicy | null {
  return observed ? { ...accepted, ...observed } : accepted;
}

function waitEnvelope(change: Change, result: PolicyWaitResult): void {
  const status = result.policy.status;
  const error = !result.settled
    ? {
      code: 'storage.policy_wait_timeout',
      message: `Still updating after ${seconds(result.waitedMs)}s. The client gave up waiting; the change was accepted and has not failed.`,
      retryable: true,
    }
    : status === 'active'
      ? null
      : { code: 'storage.policy_not_active', message: `The bucket ended in status '${status}', so the change may not have been applied.`, retryable: false };

  const observed = result.policy === ASSUMED_UPDATING ? null : result.policy;

  jsonEnvelope(latestDocument(change.accepted, observed), {
    error,
    meta: { ...change.meta, waited_ms: result.waitedMs, settled: result.settled },
  });
}

/** The exit code `handleError` gives the same failure, so a wait that failed exits as the command would have. */
function exitCodeFor(err: unknown): number {
  if (err instanceof NotAuthenticatedError) return 3;

  return err instanceof ApiError && err.statusCode === 404 ? 4 : 1;
}

/**
 * A poll failed after the change was accepted. A person is told so, and then the
 * error is reported as it would have been. A script gets one envelope that
 * carries the accepted document and says `accepted: true`: the bare API error
 * it would otherwise see reads as if the change had not been made.
 */
function reportFailedWait(change: Change, err: unknown): void {
  if (!isJsonMode()) {
    console.error(chalk.yellow(`The change was accepted, but waiting for it failed. ${checkLater(change.bucket.name)}`));
    throw err;
  }

  jsonEnvelope(change.accepted, {
    error: {
      code: 'storage.policy_wait_failed',
      message: err instanceof Error ? err.message : String(err),
      retryable: true,
      ...(err instanceof ApiError && { status: err.statusCode }),
      ...(err instanceof ApiError && err.retryAfterSeconds !== undefined && { retry_after_seconds: err.retryAfterSeconds }),
    },
    meta: { ...change.meta, accepted: true },
  });
  process.exitCode = exitCodeFor(err);
}

async function waitFor(change: Change, ceilingMs: number): Promise<PolicyWaitResult> {
  const { api, bucket, accepted } = change;
  const fetchPolicy = (timeoutMs: number) =>
    policyApi(
      () => api.get<BucketPolicy>(policyPath(bucket.id), timeoutMs),
      { bucket: bucket.name, needs: 'read', provider: bucket.provider },
    );

  return waitForPolicy(fetchPolicy, hasStatus(accepted) ? accepted : ASSUMED_UPDATING, { timeoutMs: ceilingMs });
}

/**
 * Everything after the API said yes. Without `--wait` the 202 is reported as it
 * is. With it, nothing is said about the outcome until the polls are over, and
 * under `--json` the answer is ONE envelope: the latest document, how long it
 * waited and whether it settled.
 *
 * A timeout exits 75, like the other waits the CLIENT gave up on: the change was
 * accepted and has not failed, which is neither success nor failure.
 */
export async function finishChange(change: Change): Promise<void> {
  const { bucket, accepted, ceilingMs } = change;

  if (ceilingMs === null) {
    if (isJsonMode()) {
      jsonEnvelope(accepted, { meta: change.meta });
    } else {
      change.describe();
      printAccepted(bucket.name, accepted);
    }
    return;
  }

  if (!isJsonMode()) {
    change.describe();
    console.error(chalk.dim(`Waiting for the change to finish being applied (up to ${seconds(ceilingMs)}s)...`));
  }

  let result: PolicyWaitResult;
  try {
    result = await waitFor(change, ceilingMs);
  } catch (err) {
    reportFailedWait(change, err);
    return;
  }

  if (isJsonMode()) waitEnvelope(change, result);
  else if (result.settled) printSettled(bucket.name, result.policy);
  else printTimeout(bucket.name, result.waitedMs);

  if (!result.settled) process.exitCode = CLIENT_WAIT_TIMEOUT_EXIT_CODE;
  else if (result.policy.status !== 'active') process.exitCode = 1;
}
