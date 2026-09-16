import chalk from 'chalk';
import { jsonEnvelope } from './json-mode.js';
import type { JsonErrorBody } from './json-mode.js';
import type { RunWaitResult } from './wait-for-run.js';
import type { ServerlessRun } from '../types/api.js';

/**
 * Shared by every `rapids run(s)` command that waits on a run (`run --wait`,
 * `runs logs --follow`) — the run equivalent of report-wait.ts, which does
 * this for containers.
 */

/** sysexits.h EX_TEMPFAIL: the CLIENT gave up, not the run. Retrying the wait, not the run, is what helps. */
export const CLIENT_WAIT_TIMEOUT_EXIT_CODE = 75;

function isValidExitCode(code: number | null): code is number {
  return typeof code === 'number' && Number.isInteger(code) && code >= 1 && code <= 255;
}

/**
 * The exit code for a run that HAS reached a terminal state.
 *
 * `queued`/`running` fall to the `default` — only reachable if this is called
 * on a non-terminal run, which none of the callers below do; kept defensive
 * rather than trusting an enum a server response can violate.
 */
export function exitCodeForRun(run: Pick<ServerlessRun, 'status' | 'exit_code'>): number {
  switch (run.status) {
    case 'succeeded': return 0;
    case 'failed': return isValidExitCode(run.exit_code) ? run.exit_code : 1;
    case 'timed_out': return 124;
    case 'cancelled': return 130;
    default: return 1;
  }
}

/** The exit code for a WAIT — whether or not the client gave up before the run itself settled. */
export function exitCodeForWait(result: Pick<RunWaitResult, 'settled' | 'run'>): number {
  return result.settled ? exitCodeForRun(result.run) : CLIENT_WAIT_TIMEOUT_EXIT_CODE;
}

const FAILURE_STATUSES = new Set(['failed', 'timed_out', 'cancelled']);

/** Client-synthesised error for the JSON envelope. `null` when the run succeeded. */
export function runErrorEnvelope(run: ServerlessRun): JsonErrorBody | null {
  if (!FAILURE_STATUSES.has(run.status)) return null;

  return {
    code: `serverless.run_${run.status}`,
    message: run.message ?? undefined,
    // A timeout may well pass with more time; a failed command or an
    // operator's cancel will not change on its own.
    retryable: run.status === 'timed_out',
  };
}

export function clientWaitTimeoutError(run: ServerlessRun, waitedMs: number): JsonErrorBody {
  return {
    code: 'serverless.run_wait_timeout',
    message: `Still ${run.status} after ${Math.round(waitedMs / 1000)}s. The client gave up waiting; the run has not failed.`,
    retryable: true,
  };
}

/** JSON-mode report for a wait, settled or not. `data` is always the run last observed. */
export function runJsonEnvelope(result: RunWaitResult): void {
  jsonEnvelope(result.run, {
    error: result.settled ? runErrorEnvelope(result.run) : clientWaitTimeoutError(result.run, result.waitedMs),
    meta: { waited_ms: result.waitedMs, settled: result.settled },
  });
}

export function printRunOutcome(run: ServerlessRun): void {
  switch (run.status) {
    case 'succeeded':
      console.log(chalk.green(`Run ${run.id} succeeded.`));
      break;
    case 'failed':
      console.error(chalk.red(`Run ${run.id} failed${run.exit_code !== null ? ` (exit ${run.exit_code})` : ''}.`));
      if (run.message) console.error(chalk.dim(`  ${run.message}`));
      break;
    case 'timed_out':
      console.error(chalk.red(`Run ${run.id} timed out after ${run.timeout_seconds}s.`));
      break;
    case 'cancelled':
      console.error(chalk.yellow(`Run ${run.id} was cancelled.`));
      break;
    default:
      console.error(chalk.yellow(`Run ${run.id} ended in unexpected state '${run.status}'.`));
  }
  if (run.status !== 'succeeded') {
    console.error(chalk.dim(`  danube rapids runs show ${run.container_id} ${run.id}`));
  }
}

export function printClientTimeout(run: ServerlessRun, waitedMs: number): void {
  console.error(chalk.yellow(
    `Still ${run.status} after ${Math.round(waitedMs / 1000)}s — the client gave up waiting. The run has not failed.`,
  ));
  console.error(chalk.dim(`  danube rapids runs logs ${run.container_id} ${run.id} --follow`));
  console.error(chalk.dim(`  danube rapids runs show ${run.container_id} ${run.id}`));
}

export function printRunWaitOutcome(result: RunWaitResult): void {
  if (result.settled) {
    printRunOutcome(result.run);
  } else {
    printClientTimeout(result.run, result.waitedMs);
  }
}
