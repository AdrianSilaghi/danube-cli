import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { isJsonMode, jsonEnvelope } from '../../lib/json-mode.js';
import { waitForTerminal, captureBaseline, DEFAULT_WAIT_TIMEOUT_MS } from '../../lib/wait-for-terminal.js';
import type { WaitBaseline } from '../../lib/wait-for-terminal.js';
import { waitEnvelope, printWaitOutcome } from '../../lib/report-wait.js';
import type { ServerlessContainer } from '../../types/api.js';

interface ListResponse { data: ServerlessContainer[] }
interface MutateResponse { message?: string; container: ServerlessContainer }

/**
 * Declare the desired state of a container and converge to it.
 *
 * `create` fails if the container exists and `update` fails if it does not, so
 * every automated caller ends up writing the same create-or-update dance —
 * usually by ignoring an error, which also swallows the real ones.
 *
 * With `--idempotency-key`, a create whose connection drops can be re-run
 * safely: the server returns the original response rather than a second
 * container. That is the case that makes an unattended retry loop safe, and it
 * cannot be solved on the client.
 */
export const applyCommand = new Command('apply')
  .description('Create or update a container to match the given configuration')
  .requiredOption('--name <name>', 'Container name (the identity this converges on)')
  .option('--image <image>', 'Image reference, e.g. cr.danubedata.ro/<ns>/api')
  .option('--tag <tag>', 'Image tag')
  .option('--port <port>', 'Container port')
  .option('--health-check-path <path>', 'Readiness probe path, e.g. /healthz')
  .option('--profile <profile>', 'Resource profile')
  .option('--min-scale <n>', 'Minimum scale')
  .option('--max-scale <n>', 'Maximum scale')
  .option('--registry-credential <id>', 'Registry credential UUID (omit for your own namespace)')
  .option('--env <pairs...>', 'Set environment variables (KEY=VALUE), merged with existing')
  .option('--rm-env <keys...>', 'Remove environment variables by key')
  .option('--idempotency-key <key>', 'Makes a create safe to retry after a timeout')
  .option('--wait', 'Block until the container reaches a terminal state')
  .option('--wait-timeout <duration>', 'Ceiling for --wait: 30s, 10m, 1h (default 10m)')
  .action(async (opts) => {
    const api = await ApiClient.create();

    const int = (v: string | undefined, flag: string): number | undefined => {
      if (v === undefined) return undefined;
      const n = parseInt(v, 10);
      if (Number.isNaN(n)) {
        console.error(chalk.red(`Invalid --${flag}: '${v}' is not an integer.`));
        process.exit(1);
      }
      return n;
    };

    const desired: Record<string, unknown> = {};
    if (opts.image !== undefined) desired.image = opts.image;
    if (opts.tag !== undefined) desired.image_tag = opts.tag;
    if (opts.port !== undefined) desired.port = int(opts.port, 'port');
    if (opts.healthCheckPath !== undefined) desired.health_check_path = opts.healthCheckPath;
    if (opts.profile !== undefined) desired.resource_profile = opts.profile;
    if (opts.minScale !== undefined) desired.min_scale = int(opts.minScale, 'min-scale');
    if (opts.maxScale !== undefined) desired.max_scale = int(opts.maxScale, 'max-scale');
    if (opts.registryCredential !== undefined) desired.registry_credential_id = opts.registryCredential;

    // Parsed once, up front: validity does not depend on whether the
    // container exists yet, and --rm-env alone must not require --env.
    const envPairs: Record<string, string> = {};
    if (opts.env) {
      for (const pair of opts.env as string[]) {
        const eqIndex = pair.indexOf('=');
        if (eqIndex <= 0) {
          console.error(chalk.red(`Invalid env format: '${pair}'. Use KEY=VALUE.`));
          process.exit(1);
        }
        envPairs[pair.substring(0, eqIndex)] = pair.substring(eqIndex + 1);
      }
    }
    const envRequested = Boolean(opts.env || opts.rmEnv);

    const existing = await findByName(api, opts.name);

    let container: ServerlessContainer;
    let action: 'created' | 'updated' | 'unchanged';
    let baseline: WaitBaseline | null = null;

    if (existing) {
      // Same semantics as `rapids update`: remove named keys first, then
      // overlay --env on what is left of the container's current map.
      const desiredEnv = envRequested ? mergeEnv(existing.environment_variables, envPairs, opts.rmEnv) : null;
      const envChanged = desiredEnv !== null && !envEqual(existing.environment_variables, desiredEnv);

      // Writing a configuration that already matches produces a new revision
      // for no reason — churn an agent has no way to know it caused. Compare
      // first and report `unchanged` instead.
      const drift = Object.entries(desired).filter(
        ([k, v]) => String((existing as unknown as Record<string, unknown>)[k] ?? '') !== String(v ?? ''),
      );

      if (drift.length === 0 && !envChanged) {
        container = existing;
        action = 'unchanged';
      } else {
        // Snapshot BEFORE the write. Without it the first poll cannot tell the
        // previous operation's verdict from this one's.
        baseline = await captureBaseline(api, existing.id);
        // Only the fields actually supplied are sent, so apply converges the
        // stated configuration without silently resetting anything the caller
        // did not mention.
        const body: Record<string, unknown> = { ...desired };
        if (desiredEnv !== null) body.environment_variables = desiredEnv;
        const res = await api.put<MutateResponse>(`/api/v1/serverless/${existing.id}`, body);
        container = res.container;
        action = 'updated';
      }
    } else {
      const body: Record<string, unknown> = {
        name: opts.name,
        slug: slugify(opts.name),
        deployment_type: 'docker_image',
        ...desired,
      };
      // A brand new container has no environment to remove from, so --rm-env
      // alone (no --env) is a true no-op here rather than an empty map sent
      // to the API.
      if (opts.env) body.environment_variables = envPairs;
      const res = await api.post<MutateResponse>(
        '/api/v1/serverless',
        body,
        opts.idempotencyKey ? { 'Idempotency-Key': String(opts.idempotencyKey) } : undefined,
      );
      container = res.container;
      action = 'created';
    }

    // A no-op has nothing to converge to, so waiting would just re-confirm the
    // state we already read.
    if (!opts.wait || action === 'unchanged') {
      if (isJsonMode()) {
        jsonEnvelope(waitEnvelope(action, container, {
          settled: action === 'unchanged',
          status: container.status_details ?? null,
          url: container.url,
          targetRevision: container.current_revision ?? null,
          observedAt: container.status_details?.observed_at ?? null,
          sawFreshObservation: true,
          observedGeneration: container.observed_generation ?? null,
          waitedMs: 0,
        }), { meta: { waited: false } });
        return;
      }
      console.log(chalk.green(`${action}: ${container.name}`));
      console.log(`ID: ${container.id}`);
      return;
    }

    if (!isJsonMode()) {
      console.error(chalk.dim(`${action} ${container.name}; waiting for a terminal state...`));
    }

    const wait = await waitForTerminal(api, container.id, {
      timeoutMs: parseDuration(opts.waitTimeout) ?? DEFAULT_WAIT_TIMEOUT_MS,
      baseline,
      minGeneration: container.spec_generation ?? null,
    });

    if (isJsonMode()) {
      const err = wait.status?.error ?? null;
      jsonEnvelope(waitEnvelope(action, container, wait), {
        error: wait.settled && err ? { code: err.code, message: err.message ?? undefined, retryable: err.retryable } : null,
        meta: { waited: true, fresh_observation: wait.sawFreshObservation },
      });
    } else {
      printWaitOutcome(wait, container.name);
    }

    // Same rule as `create --wait`: only a settled failure is a failure. A
    // timeout means still deploying, and degraded means an older revision is
    // serving, so neither should fail a pipeline.
    if (wait.settled && (wait.status?.summary === 'failed' || wait.status?.health === 'unhealthy')) {
      process.exitCode = 1;
    }
  });

async function findByName(api: ApiClient, name: string): Promise<ServerlessContainer | null> {
  const res = await api.get<ListResponse>('/api/v1/serverless');
  const wanted = name.toLowerCase();
  const slug = slugify(name);

  return res.data.find((c) => c.name.toLowerCase() === wanted || c.slug === slug) ?? null;
}

/** Mirrors the API's slug rule: lowercase alphanumerics and hyphens, max 63. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

function parseDuration(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = /^(\d+)([smh])$/.exec(value.trim());
  if (!m) {
    console.error(chalk.red(`Invalid --wait-timeout: '${value}'. Use 30s, 10m or 1h.`));
    process.exit(1);
  }
  return parseInt(m[1]!, 10) * ({ s: 1_000, m: 60_000, h: 3_600_000 }[m[2]!] ?? 1_000);
}

/** Order-insensitive map equality — same keys, same values. */
function envEqual(existing: Record<string, string> | null | undefined, desired: Record<string, string>): boolean {
  const current = existing ?? {};
  const currentKeys = Object.keys(current);
  const desiredKeys = Object.keys(desired);
  if (currentKeys.length !== desiredKeys.length) return false;
  return currentKeys.every((k) => current[k] === desired[k]);
}

/** Same merge semantics as `rapids update`: remove named keys, then overlay --env. */
function mergeEnv(
  existing: Record<string, string> | null | undefined,
  envPairs: Record<string, string>,
  rmEnv: string[] | undefined,
): Record<string, string> {
  const merged: Record<string, string> = { ...(existing ?? {}) };
  if (rmEnv) {
    for (const key of rmEnv) delete merged[key];
  }
  return { ...merged, ...envPairs };
}
