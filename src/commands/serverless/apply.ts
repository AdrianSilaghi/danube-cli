import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import { waitForTerminal, captureBaseline, DEFAULT_WAIT_TIMEOUT_MS } from '../../lib/wait-for-terminal.js';
import type { WaitBaseline, WaitResult } from '../../lib/wait-for-terminal.js';
import type { ServerlessContainer, ServerlessStatusDetails } from '../../types/api.js';

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

    const existing = await findByName(api, opts.name);

    let container: ServerlessContainer;
    let action: 'created' | 'updated' | 'unchanged';
    let baseline: WaitBaseline | null = null;

    if (existing) {
      // Writing a configuration that already matches produces a new revision
      // for no reason — churn an agent has no way to know it caused. Compare
      // first and report `unchanged` instead.
      const drift = Object.entries(desired).filter(
        ([k, v]) => String((existing as unknown as Record<string, unknown>)[k] ?? '') !== String(v ?? ''),
      );

      if (drift.length === 0) {
        container = existing;
        action = 'unchanged';
      } else {
        // Snapshot BEFORE the write. Without it the first poll cannot tell the
        // previous operation's verdict from this one's.
        baseline = await captureBaseline(api, existing.id);
        // Only the fields actually supplied are sent, so apply converges the
        // stated configuration without silently resetting anything the caller
        // did not mention.
        const res = await api.put<MutateResponse>(`/api/v1/serverless/${existing.id}`, desired);
        container = res.container;
        action = 'updated';
      }
    } else {
      const body = {
        name: opts.name,
        slug: slugify(opts.name),
        deployment_type: 'docker_image',
        ...desired,
      };
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
        jsonOutput(result(action, container, {
          settled: action === 'unchanged',
          status: container.status_details ?? null,
          url: container.url,
          targetRevision: container.current_revision ?? null,
          observedAt: container.status_details?.observed_at ?? null,
          sawFreshObservation: true,
          waitedMs: 0,
        }));
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
    });

    if (isJsonMode()) {
      jsonOutput(result(action, container, wait));
    } else {
      report(wait, container.name);
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

/**
 * Compact result. The full container resource is ~60 fields of git/build
 * defaults that have nothing to do with the outcome; an agent pays for every
 * one of them and has to find the four that matter.
 */
function result(action: string, container: ServerlessContainer, wait: WaitResult) {
  return {
    action,
    container_id: container.id,
    name: container.name,
    settled: wait.settled,
    terminal: wait.status?.operation.terminal ?? null,
    summary: wait.status?.summary ?? null,
    health: wait.status?.health ?? null,
    target_revision: wait.targetRevision,
    // Server clock, so a caller can tell a fresh verdict from a cached one.
    observed_at: wait.observedAt,
    // False means we never saw the platform re-observe after the write, so the
    // verdict above describes the PREVIOUS state.
    fresh_observation: wait.sawFreshObservation,
    url: wait.url,
    error: wait.status?.error ?? null,
    waited_ms: wait.waitedMs,
  };
}

function report(wait: WaitResult, name: string): void {
  const status = wait.status;
  if (!wait.settled) {
    if (!wait.sawFreshObservation) {
      console.error(chalk.yellow(
        'Timed out before the platform re-observed this container, so no verdict here would describe your change.',
      ));
    } else {
      console.error(chalk.yellow(`Still deploying (${status?.summary ?? 'unknown'}). Not a failure — the rollout continues.`));
    }
    console.error(chalk.dim(`Watch: danube rapids diagnose ${name} --json`));
    return;
  }
  if (wait.targetRevision) console.log(chalk.dim(`Revision: ${wait.targetRevision}`));
  if (status?.summary === 'ready') {
    console.log(chalk.green('Ready'));
    if (wait.url) console.log(`URL: ${wait.url}`);
    return;
  }
  if (status?.summary === 'degraded') {
    console.log(chalk.yellow('Degraded — the new revision failed, an older one is still serving.'));
    if (wait.url) console.log(`URL: ${wait.url}`);
  } else {
    console.log(chalk.red(String(status?.summary ?? 'unknown')));
  }
  if (status?.error) {
    console.log(`  ${chalk.bold(status.error.code)}${status.error.retryable ? chalk.dim(' (retryable)') : ''}`);
    if (status.error.message) console.log(`  ${status.error.message}`);
  }
  console.log(chalk.dim(`  danube rapids diagnose ${name} --json`));
}
