import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client.js';
import { resolveAlias } from '../../lib/flag-alias.js';
import { resolveContainer } from './resolve.js';
import { isJsonMode, jsonOutput, jsonEnvelope } from '../../lib/json-mode.js';
import { waitForTerminal, captureBaseline, DEFAULT_WAIT_TIMEOUT_MS } from '../../lib/wait-for-terminal.js';
import type { WaitBaseline } from '../../lib/wait-for-terminal.js';
import { waitEnvelope, printWaitOutcome } from '../../lib/report-wait.js';
import type { ServerlessContainer } from '../../types/api.js';
import { parseDurationSeconds } from '../../lib/duration.js';
import { ensureSecretSupport, mergeEnv, putMergedEnvironment, reconcileKinds } from '../../lib/serverless-env.js';
import { readEnvironmentFlags } from '../../lib/env-input.js';

export const updateCommand = new Command('update')
  .description('Update a serverless container')
  .argument('<name-or-id>', 'Container name or ID')
  .option('--image <image>', 'Docker image')
  .option('--tag <tag>', 'Image tag')
  .option('--resource-profile <profile>', 'Resource profile (canonical)')
  .option('--profile <profile>', 'Alias for --resource-profile')
  .option('--port <port>', 'Container port')
  .option('--min-scale <n>', 'Minimum replicas (0 for scale-to-zero)')
  .option('--max-scale <n>', 'Maximum replicas')
  .option('--initial-scale <n>', 'Instances a new revision starts with before it counts as ready (0..max-scale)')
  .option('--scale-down-delay <duration>', 'How long the previous revision keeps its instances after losing traffic: 0, 30s, 5m, 1h')
  .option('--scaling-metric <metric>', 'Scaling metric (rps or concurrency)')
  .option('--scaling-target <n>', 'Target value per pod for scaling metric')
  .option('--concurrency-target <n>', 'Concurrency target per pod')
  .option('--timeout <seconds>', 'Request timeout in seconds (max 900)')
  .option('--env <pairs...>', 'Set environment variables (KEY=VALUE, or KEY to read it from your environment), merged with existing')
  .option('--env-file <path>', 'Read environment variables from a dotenv file (- for the standard input); --env wins')
  .option('--rm-env <keys...>', 'Remove environment variables by key')
  .option('--secret <pairs...>', 'Set write-only secret variables (KEY=VALUE, or KEY to read it from your environment)')
  .option('--secret-file <path>', 'Read secret variables from a dotenv file (- for the standard input)')
  .option('--rm-secret <keys...>', 'Remove secret variables by key')
  .option('--wait', 'Block until the container reaches a terminal state')
  .option('--wait-timeout <duration>', 'Ceiling for --wait: 30s, 10m, 1h (default 10m)')
  .action(async (nameOrId: string, opts) => {
    // Read before any request: a bad flag or file fails without touching the API.
    const requested = await readEnvironmentFlags(opts);
    const envPairs = requested.env;

    const api = await ApiClient.create();
    const listed = await resolveContainer(api, nameOrId);
    // Refuses, before any write, a platform that would drop the secrets without saying so.
    const container = Object.keys(requested.secrets).length > 0 ? await ensureSecretSupport(api, listed) : listed;
    // A key set as a secret that is plain now (or the reverse) is moved in the same write.
    const kinds = reconcileKinds(container, envPairs, requested.secrets, opts.rmEnv);
    const secrets = requested.secrets;
    const rmEnv = kinds.rmEnv;
    // stderr, also under --json: stdout stays one clean document.
    for (const note of kinds.notes) console.error(chalk.dim(note));

    const parseIntOption = (val: string, name: string): number => {
      const n = parseInt(val, 10);
      if (isNaN(n)) {
        console.error(chalk.red(`Invalid value for ${name}: '${val}' is not an integer.`));
        process.exit(1);
      }
      return n;
    };

    const body: Record<string, unknown> = {};
    if (opts.image) body.image = opts.image;
    if (opts.tag) body.image_tag = opts.tag;
    const resourceProfile = resolveAlias('resource-profile', [
      ['--resource-profile', opts.resourceProfile],
      ['--profile', opts.profile],
    ]);
    if (resourceProfile) body.resource_profile = resourceProfile;
    if (opts.port) body.port = parseIntOption(opts.port, '--port');
    if (opts.minScale !== undefined) body.min_scale = parseIntOption(opts.minScale, '--min-scale');
    if (opts.maxScale !== undefined) body.max_scale = parseIntOption(opts.maxScale, '--max-scale');
    if (opts.initialScale !== undefined) body.initial_scale = parseIntOption(opts.initialScale, '--initial-scale');
    if (opts.scaleDownDelay !== undefined) body.scale_down_delay_seconds = parseDurationSeconds(opts.scaleDownDelay);
    if (opts.scalingMetric) body.scaling_metric = opts.scalingMetric;
    if (opts.scalingTarget !== undefined) body.scaling_target = parseIntOption(opts.scalingTarget, '--scaling-target');
    if (opts.concurrencyTarget !== undefined) body.concurrency_target = parseIntOption(opts.concurrencyTarget, '--concurrency-target');
    if (opts.timeout !== undefined) body.timeout_seconds = parseIntOption(opts.timeout, '--timeout');

    // Environment changes merge into the container's current map when written.
    const envRequested = Boolean(opts.env || opts.envFile || rmEnv.length > 0);
    // Secrets merge on the server (a string sets, null removes), so only the delta is sent.
    const secretsRequested = Object.keys(secrets).length > 0;
    if (secretsRequested) body.secret_environment_variables = secrets;

    if (Object.keys(body).length === 0 && !envRequested) {
      console.error(chalk.red('No update options specified. Use --help for available options.'));
      process.exit(1);
    }

    let baseline: WaitBaseline | null = null;
    if (opts.wait) {
      // Snapshot BEFORE the write. Without it the first poll cannot tell the
      // previous operation's verdict from this one's.
      baseline = await captureBaseline(api, container.id);
    }

    const spinner = isJsonMode() || opts.wait ? null : ora('Updating container...').start();
    type UpdateResponse = { message: string; container: ServerlessContainer };
    // A secrets-only change still sends the environment snapshot, which covers secret names.
    const res = envRequested || secretsRequested
      ? await putMergedEnvironment<UpdateResponse>(
          api,
          container,
          envRequested ? (env) => mergeEnv(env, envPairs, rmEnv) : null,
          body,
        )
      : await api.put<UpdateResponse>(`/api/v1/serverless/${container.id}`, body);

    // The platform bumps the generation only when something it stores changed.
    // Writing what is already there rolls nothing out, and a --wait for a
    // rollout that is not coming would only run out its timeout.
    const generation = res.container.spec_generation;
    if (typeof generation === 'number' && generation === container.spec_generation) {
      const text = `No change: generation ${generation} is already current, so nothing is rolling out.`;
      if (isJsonMode() && opts.wait) {
        // The shape a completed --wait has, so a caller parses one thing: terminal, at the current generation.
        jsonEnvelope(waitEnvelope('unchanged', res.container, {
          settled: true,
          status: res.container.status_details ?? null,
          url: res.container.url,
          targetRevision: res.container.current_revision ?? null,
          observedAt: res.container.status_details?.observed_at ?? null,
          sawFreshObservation: true,
          observedGeneration: res.container.observed_generation ?? null,
          waitedMs: 0,
        }), { meta: { waited: false, fresh_observation: true } });
      } else if (isJsonMode()) jsonOutput(res.container);
      else if (spinner) spinner.succeed(text);
      else console.log(text);
      return;
    }

    if (!opts.wait) {
      if (isJsonMode()) {
        jsonOutput(res.container);
        return;
      }
      // The PUT only records the change: the rollout runs on after it returns.
      spinner!.succeed(
        `Update accepted; rolling out${generation == null ? '' : ` generation ${generation}`}. ` +
        'Pass --wait to block until it is live.',
      );
      return;
    }

    // --wait, mirroring `apply --wait`: no spinner (there is nothing to spin
    // on past this point) and progress goes to stderr so `--json` stdout
    // stays a clean document a caller can pipe straight into a parser.
    if (!isJsonMode()) {
      console.error(chalk.dim(`updated ${res.container.name}; waiting for a terminal state...`));
    }

    const wait = await waitForTerminal(api, res.container.id, {
      timeoutMs: parseDuration(opts.waitTimeout) ?? DEFAULT_WAIT_TIMEOUT_MS,
      baseline,
      minGeneration: res.container.spec_generation ?? null,
    });

    if (isJsonMode()) {
      const err = wait.status?.error ?? null;
      jsonEnvelope(waitEnvelope('updated', res.container, wait), {
        error: wait.settled && err ? { code: err.code, message: err.message ?? undefined, retryable: err.retryable } : null,
        meta: { waited: true, fresh_observation: wait.sawFreshObservation },
      });
    } else {
      printWaitOutcome(wait, res.container.name);
    }

    // Same rule as apply/create --wait: only a settled failure is a failure.
    // A timeout means still deploying, and degraded means an older revision
    // is serving, so neither should fail a pipeline.
    if (wait.settled && (wait.status?.summary === 'failed' || wait.status?.health === 'unhealthy')) {
      process.exitCode = 1;
    }
  });

function parseDuration(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = /^(\d+)([smh])$/.exec(value.trim());
  if (!m) {
    console.error(chalk.red(`Invalid --wait-timeout: '${value}'. Use 30s, 10m or 1h.`));
    process.exit(1);
  }
  return parseInt(m[1]!, 10) * ({ s: 1_000, m: 60_000, h: 3_600_000 }[m[2]!] ?? 1_000);
}
