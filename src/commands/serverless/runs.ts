import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { resolveContainer } from './resolve.js';
import { runsApi } from '../../lib/rapids-runs.js';
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
import { ApiError } from '../../lib/errors.js';
import type { Envelope, ServerlessRun, ServerlessRunLogs } from '../../types/api.js';

const runsPath = (containerId: string): string => `/api/v1/serverless/${containerId}/runs`;
const runPath = (containerId: string, runId: string): string => `${runsPath(containerId)}/${runId}`;
const logsPath = (containerId: string, runId: string): string => `${runPath(containerId, runId)}/logs`;

function formatCommand(command: string[] | null): string {
  if (!command || command.length === 0) return chalk.dim('(image default)');
  return command.join(' ');
}

const formatSeconds = (n: number | null): string => (n === null ? '-' : `${n}s`);

export const lsCommand = new Command('ls')
  .description('List runs for a rapids container')
  .argument('<name-or-id>', 'Container name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const container = await resolveContainer(api, nameOrId);

    const res = await runsApi(() => api.get<Envelope<ServerlessRun[]>>(runsPath(container.id)));

    if (isJsonMode()) {
      jsonEnvelope(res.data, { error: res.error ?? null, meta: res.meta ?? {} });
      return;
    }

    if (res.data.length === 0) {
      console.log(chalk.dim('No runs yet.'));
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

    const total = res.meta?.total;
    if (typeof total === 'number' && total > res.data.length) {
      console.log(chalk.dim(`Showing ${res.data.length} of ${total}.`));
    }
  });

export const showCommand = new Command('show')
  .description("Show a run's status and details")
  .argument('<name-or-id>', 'Container name or ID')
  .argument('<run-id>', 'Run ID')
  .action(async (nameOrId: string, runId: string) => {
    const api = await ApiClient.create();
    const container = await resolveContainer(api, nameOrId);

    const res = await runsApi(() => api.get<Envelope<ServerlessRun>>(runPath(container.id, runId)));

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
      const res = await runsApi(() => api.get<Envelope<ServerlessRunLogs>>(logsPath(container.id, runId)));
      if (isJsonMode()) {
        jsonOutput(res.data);
        return;
      }
      console.log(sanitize(res.data.logs) || chalk.dim('No logs yet.'));
      return;
    }

    const tailState: LogTailState = { printed: '' };
    const wait = await runsApi(() => waitForRun(api, container.id, runId, {
      timeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
      onTick: isJsonMode()
        ? undefined
        : (r) => streamNewLogs(api, logsPath(container.id, r.id), tailState, (text) => process.stdout.write(text)),
    }));

    const finalLogs = await runsApi(() => api.get<Envelope<ServerlessRunLogs>>(logsPath(container.id, wait.run.id)));

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
      const res = await runsApi(() => api.post<Envelope<ServerlessRun>>(`${runPath(container.id, runId)}/cancel`));

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
