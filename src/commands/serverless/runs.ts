import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { resolveContainer } from './resolve.js';
import { runsApi, runsApiForRun, reportRunNotFound, reportRunDisappeared } from '../../lib/rapids-runs.js';
import { waitForRun, DEFAULT_WAIT_TIMEOUT_MS } from '../../lib/wait-for-run.js';
import { streamNewLogs } from '../../lib/log-tail.js';
import type { LogTailState } from '../../lib/log-tail.js';
import {
  exitCodeForWait,
  runErrorEnvelope,
  clientWaitTimeoutError,
  printRunOutcome,
  printClientTimeout,
} from '../../lib/report-run.js';
import { isJsonMode, jsonOutput, jsonEnvelope } from '../../lib/json-mode.js';
import { formatTable, formatDate, statusColor, printDetails } from '../../lib/output.js';
import { sanitize } from '../../lib/log-text.js';
import { ApiError, UsageError } from '../../lib/errors.js';
import type { Envelope, ServerlessRun, ServerlessRunLogs } from '../../types/api.js';

const runsPath = (containerId: string): string => `/api/v1/serverless/${containerId}/runs`;
const runPath = (containerId: string, runId: string): string => `${runsPath(containerId)}/${runId}`;
const logsPath = (containerId: string, runId: string): string => `${runPath(containerId, runId)}/logs`;

function formatCommand(command: string[] | null): string {
  if (!command || command.length === 0) return chalk.dim('(image default)');
  return command.join(' ');
}

const formatSeconds = (n: number | null): string => (n === null ? '-' : `${n}s`);

/** The largest page the API answers; it clamps a larger `per_page` to this. */
const MAX_RUNS_PER_PAGE = 200;

/** A whole number from `min` (to `max`), or a UsageError naming the flag: `--page 2x` is a typo, not page 2. */
function parseWholeNumber(flag: string, raw: string, min: number, max?: number): number {
  const n = Number(raw.trim());
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(n) || n < min || (max !== undefined && n > max)) {
    throw new UsageError(`Invalid ${flag} "${raw}". Expected a whole number ${max === undefined ? `of at least ${min}` : `from ${min} to ${max}`}.`);
  }
  return n;
}

/**
 * The line under a page of runs: how many there are in all and, when older ones
 * remain, the flags that show the next page. Without `current_page` and
 * `last_page` in the answer, it gives the count alone.
 */
function pageNote(meta: Record<string, unknown> | undefined, shown: number, limit: number | undefined): string | null {
  const total = meta?.total;
  if (typeof total !== 'number' || total <= shown) return null;

  const current = meta?.current_page;
  const last = meta?.last_page;
  if (typeof current !== 'number' || typeof last !== 'number') return `Showing ${shown} of ${total}.`;

  const next = current < last ? ` Older runs: --page ${current + 1}${limit === undefined ? '' : ` --limit ${limit}`}.` : '';
  return `Showing ${shown} of ${total}, page ${current} of ${last}.${next}`;
}

export const lsCommand = new Command('ls')
  .description('List runs for a rapids container, newest first')
  .argument('<name-or-id>', 'Container name or ID')
  .option('--limit <n>', `Runs per page, 1 to ${MAX_RUNS_PER_PAGE} (default 20)`)
  .option('--page <n>', 'Which page to show, from 1')
  .action(async (nameOrId: string, opts: { limit?: string; page?: string }) => {
    // Checked before any request, so a typo costs nothing.
    const limit = opts.limit === undefined ? undefined : parseWholeNumber('--limit', opts.limit, 1, MAX_RUNS_PER_PAGE);
    const page = opts.page === undefined ? undefined : parseWholeNumber('--page', opts.page, 1);
    const query = new URLSearchParams();
    if (limit !== undefined) query.set('per_page', String(limit));
    if (page !== undefined) query.set('page', String(page));

    const api = await ApiClient.create();
    const container = await resolveContainer(api, nameOrId);

    const qs = query.toString();
    const path = qs === '' ? runsPath(container.id) : `${runsPath(container.id)}?${qs}`;
    const res = await runsApi(() => api.get<Envelope<ServerlessRun[]>>(path));

    if (isJsonMode()) {
      jsonEnvelope(res.data, { error: res.error ?? null, meta: res.meta ?? {} });
      return;
    }

    if (res.data.length === 0) {
      const total = res.meta?.total;
      console.log(chalk.dim(typeof total === 'number' && total > 0 ? `No runs on this page; there are ${total} in all.` : 'No runs yet.'));
      return;
    }

    console.log(formatTable(
      ['ID', 'STATUS', 'EXIT', 'STARTED', 'DURATION', 'COMMAND'],
      res.data.map((r) => [
        r.id,
        statusColor(r.status),
        r.exit_code === null ? '-' : String(r.exit_code),
        r.started_at ? formatDate(r.started_at) : '-',
        formatSeconds(r.duration_seconds),
        formatCommand(r.command),
      ]),
    ));

    const note = pageNote(res.meta, res.data.length, limit);
    if (note !== null) {
      console.log(chalk.dim(note));
    }
  });

export const showCommand = new Command('show')
  .description("Show a run's status and details")
  .argument('<name-or-id>', 'Container name or ID')
  .argument('<run-id>', 'Run ID')
  .action(async (nameOrId: string, runId: string) => {
    const api = await ApiClient.create();
    const container = await resolveContainer(api, nameOrId);

    const res = await runsApiForRun(
      () => api.get<Envelope<ServerlessRun>>(runPath(container.id, runId)),
      () => reportRunNotFound(runId, container.name),
    );

    if (isJsonMode()) {
      jsonOutput(res.data);
      return;
    }

    const r = res.data;
    console.log(chalk.bold(r.id));
    printDetails([
      ['Status', statusColor(r.status)],
      ['Image', r.image],
      ['Command', formatCommand(r.command)],
      ['Exit Code', r.exit_code === null ? '-' : String(r.exit_code)],
      ['Timeout', `${r.timeout_seconds}s`],
      ['Created', formatDate(r.created_at)],
      ['Started', r.started_at ? formatDate(r.started_at) : '-'],
      ['Finished', r.finished_at ? formatDate(r.finished_at) : '-'],
      ['Duration', formatSeconds(r.duration_seconds)],
    ]);
    if (r.message) console.log(chalk.dim(`\n${r.message}`));
  });

export const logsCommand = new Command('logs')
  .description('Fetch logs for a run')
  .argument('<name-or-id>', 'Container name or ID')
  .argument('<run-id>', 'Run ID')
  .option('--follow', 'Keep polling until the run reaches a terminal state')
  .action(async (nameOrId: string, runId: string, opts: { follow?: boolean }) => {
    const api = await ApiClient.create();
    const container = await resolveContainer(api, nameOrId);

    if (!opts.follow) {
      const res = await runsApiForRun(
        () => api.get<Envelope<ServerlessRunLogs>>(logsPath(container.id, runId)),
        () => reportRunNotFound(runId, container.name),
      );
      if (isJsonMode()) {
        jsonOutput(res.data);
        return;
      }
      console.log(sanitize(res.data.logs) || chalk.dim('No logs yet.'));
      return;
    }

    const tailState: LogTailState = { printed: '' };
    const wait = await runsApiForRun(
      () => waitForRun(api, container.id, runId, {
        timeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
        onTick: isJsonMode()
          ? undefined
          : (r) => streamNewLogs(api, logsPath(container.id, r.id), tailState, (text) => process.stdout.write(text)),
      }),
      () => reportRunDisappeared(runId),
    );

    const finalLogs = await runsApiForRun(
      () => api.get<Envelope<ServerlessRunLogs>>(logsPath(container.id, wait.run.id)),
      () => reportRunDisappeared(runId),
    );

    if (isJsonMode()) {
      jsonEnvelope(finalLogs.data, {
        error: wait.settled ? runErrorEnvelope(wait.run) : clientWaitTimeoutError(wait.run, wait.waitedMs),
        meta: { run: wait.run, settled: wait.settled, waited_ms: wait.waitedMs },
      });
    } else if (wait.settled) {
      printRunOutcome(wait.run);
    } else {
      printClientTimeout(wait.run, wait.waitedMs);
    }

    const code = exitCodeForWait(wait);
    if (code !== 0) process.exitCode = code;
  });

export const cancelCommand = new Command('cancel')
  .description('Cancel an active run')
  .argument('<name-or-id>', 'Container name or ID')
  .argument('<run-id>', 'Run ID')
  .action(async (nameOrId: string, runId: string) => {
    const api = await ApiClient.create();
    const container = await resolveContainer(api, nameOrId);

    try {
      const res = await runsApiForRun(
        () => api.post<Envelope<ServerlessRun>>(`${runPath(container.id, runId)}/cancel`),
        () => reportRunNotFound(runId, container.name),
      );

      if (isJsonMode()) {
        jsonOutput(res.data);
        return;
      }
      console.log(chalk.green(`Cancel requested for ${res.data.id}`));
      console.log(`Status: ${statusColor(res.data.status)}`);
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 409) {
        reportRunNotActive(err);
      }
      throw err;
    }
  });

/** 409: the run is not active any more (already terminal, or already cancelling). */
function reportRunNotActive(err: ApiError): never {
  if (isJsonMode()) {
    jsonEnvelope(null, {
      error: {
        code: err.cause?.code ?? 'serverless.run_not_active',
        message: err.message,
        retryable: err.cause?.retryable ?? false,
      },
      meta: {},
    });
  } else {
    console.error(chalk.red(err.message));
  }

  process.exit(1);
}
