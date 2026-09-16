import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { resolveContainer } from './resolve.js';
import { runsApi, runsApiForRun, reportRunDisappeared } from '../../lib/rapids-runs.js';
import { waitForRun, DEFAULT_WAIT_TIMEOUT_MS } from '../../lib/wait-for-run.js';
import { streamNewLogs } from '../../lib/log-tail.js';
import type { LogTailState } from '../../lib/log-tail.js';
import { exitCodeForWait, printRunWaitOutcome, runJsonEnvelope } from '../../lib/report-run.js';
import { isJsonMode, jsonOutput, jsonEnvelope } from '../../lib/json-mode.js';
import { parseDuration } from '../../lib/duration.js';
import { statusColor } from '../../lib/output.js';
import { ApiError } from '../../lib/errors.js';
import type { ServerlessContainer, ServerlessRun, Envelope } from '../../types/api.js';

interface RunOptions {
  tag?: string;
  env?: string[];
  timeout?: string;
  wait?: boolean;
  waitTimeout?: string;
  /** Always defined: `--no-logs` sets it `false`, otherwise Commander defaults it `true`. */
  logs: boolean;
}

/**
 * Run a container's image ONCE, on demand, as a Kubernetes Job.
 *
 * Exists because scaling a container up and down to run a migration can run
 * it twice — this is the alternative CI reaches for instead: at most one
 * active run per container, with a status, an exit code, and logs.
 */
export const runCommand = new Command('run')
  .description("Run a container's image once, on demand, as a Kubernetes Job")
  .argument('<name-or-id>', 'Container name or ID')
  .argument('[command...]', 'Command to run, after --, e.g. -- npm run migrate')
  .option('--tag <tag>', "Image tag to run (defaults to the container's current tag)")
  .option('--env <pairs...>', 'Environment variables for this run only (KEY=VALUE)')
  .option('--timeout <duration>', 'Run timeout: 30s, 10m, 1h (server default 15m)')
  .option('--wait', 'Block until the run reaches a terminal state')
  .option('--wait-timeout <duration>', 'Ceiling for --wait: 30s, 10m, 1h (default 10m)')
  .option('--no-logs', 'Do not stream logs while waiting')
  .action(async (nameOrId: string, command: string[], opts: RunOptions) => {
    const api = await ApiClient.create();
    const container = await resolveContainer(api, nameOrId);

    const body: Record<string, unknown> = {};
    if (command.length > 0) body.command = command;
    if (opts.tag) body.image_tag = opts.tag;
    if (opts.timeout) body.timeout_seconds = Math.round(parseDuration(opts.timeout) / 1000);

    if (opts.env) {
      const env: Record<string, string> = {};
      for (const pair of opts.env) {
        const eqIndex = pair.indexOf('=');
        if (eqIndex <= 0) {
          console.error(chalk.red(`Invalid env format: '${pair}'. Use KEY=VALUE.`));
          process.exit(1);
        }
        env[pair.substring(0, eqIndex)] = pair.substring(eqIndex + 1);
      }
      body.env = env;
    }

    const run = await createRun(api, container, body);

    if (!opts.wait) {
      if (isJsonMode()) {
        jsonOutput(run);
        return;
      }
      console.log(chalk.green(`Started run ${run.id}`));
      console.log(`Status: ${statusColor(run.status)}`);
      console.log(chalk.dim(`  danube rapids runs show ${nameOrId} ${run.id}`));
      return;
    }

    if (!isJsonMode()) {
      console.error(chalk.dim(`started ${run.id}; waiting for a terminal state...`));
    }

    const tailState: LogTailState = { printed: '' };
    const wait = await runsApiForRun(
      () => waitForRun(api, container.id, run.id, {
        timeoutMs: parseWaitTimeout(opts.waitTimeout) ?? DEFAULT_WAIT_TIMEOUT_MS,
        onTick: opts.logs
          ? (r) => streamNewLogs(
            api,
            `/api/v1/serverless/${container.id}/runs/${r.id}/logs`,
            tailState,
            (text) => process.stderr.write(text),
          )
          : undefined,
      }),
      () => reportRunDisappeared(run.id),
    );

    if (isJsonMode()) {
      runJsonEnvelope(wait);
    } else {
      printRunWaitOutcome(wait);
    }

    const code = exitCodeForWait(wait);
    if (code !== 0) process.exitCode = code;
  });

async function createRun(
  api: ApiClient,
  container: ServerlessContainer,
  body: Record<string, unknown>,
): Promise<ServerlessRun> {
  try {
    const res = await runsApi(() => api.post<Envelope<ServerlessRun>>(`/api/v1/serverless/${container.id}/runs`, body));
    return res.data;
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 409) {
      reportRunInProgress(err);
    }
    throw err;
  }
}

/**
 * 409: another run is already active for this container (at most one at a
 * time). The API names it in `meta.active_run_id` — surfaced here rather than
 * left for a caller to re-derive from prose.
 */
function reportRunInProgress(err: ApiError): never {
  const activeRunId = typeof err.meta?.active_run_id === 'string' ? err.meta.active_run_id : null;

  if (isJsonMode()) {
    jsonEnvelope(null, {
      error: {
        code: err.cause?.code ?? 'serverless.run_in_progress',
        message: err.message,
        retryable: err.cause?.retryable ?? false,
      },
      meta: { active_run_id: activeRunId },
    });
  } else {
    console.error(chalk.red(err.message));
    if (activeRunId) console.error(chalk.dim(`Active run: ${activeRunId}`));
  }

  process.exit(1);
}

/** Mirrors `apply --wait-timeout` / `update --wait-timeout` exactly — see serverless/apply.ts. */
function parseWaitTimeout(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = /^(\d+)([smh])$/.exec(value.trim());
  if (!m) {
    console.error(chalk.red(`Invalid --wait-timeout: '${value}'. Use 30s, 10m or 1h.`));
    process.exit(1);
  }
  return parseInt(m[1]!, 10) * ({ s: 1_000, m: 60_000, h: 3_600_000 }[m[2]!] ?? 1_000);
}
