import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { resolveContainer } from './resolve.js';
import { isJsonMode, jsonEnvelope } from '../../lib/json-mode.js';
import { UsageError } from '../../lib/errors.js';

/** Container values the API accepts. Mirrors ServerlessLogsService::CONTAINERS. */
const CONTAINERS = ['user-container', 'queue-proxy', 'all'] as const;

/** Mirrors ServerlessLogsService::LEVELS. */
const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message?: string; retryable?: boolean } | null;
  meta?: Record<string, unknown>;
}

/**
 * Translate `1h` / `30m` / `7d` into an absolute ISO timestamp.
 *
 * Absolute times are what the API validates against its retention window, and
 * resolving here means the server never has to guess what "now" meant to a
 * client whose clock may differ.
 */
export function parseSince(value: string): string {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) {
    throw new UsageError(`Invalid --since "${value}". Use a duration like 30m, 6h or 2d.`);
  }

  const amount = Number(match[1]);
  const seconds = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as 's' | 'm' | 'h' | 'd'];

  return new Date(Date.now() - amount * seconds * 1000).toISOString();
}

/**
 * Strip ANSI escapes and other control characters from log text.
 *
 * Log lines are attacker-influenced: whatever a container prints ends up here.
 * Without this, a crafted line can repaint the terminal, hide itself with a
 * carriage return, or emit an OSC sequence — so an operator reading logs
 * cannot trust what they are seeing. Tabs and newlines are kept; everything
 * else in the C0/C1 control range is removed.
 */
export function sanitize(text: string): string {
  return text
    // CSI / ANSI escape sequences (colours, cursor movement, screen clears).
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    // OSC sequences (window title, hyperlinks), terminated by BEL or ST.
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    // Any remaining single-character escapes.
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b[@-_]/g, '')
    // Remaining C0/C1 controls, keeping tab (09) and newline (0A).
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

function assertOneOf(name: string, value: string | undefined, allowed: readonly string[]): void {
  if (value !== undefined && !allowed.includes(value)) {
    throw new UsageError(`Invalid --${name} "${value}". Expected one of: ${allowed.join(', ')}.`);
  }
}

const logsCommand = new Command('logs')
  .description('Fetch logs for a rapids container')
  .argument('<name-or-id>', 'Container name or ID')
  .option('--since <duration>', 'Look back this far (e.g. 30m, 6h, 2d)')
  .option('--limit <n>', 'Maximum entries to return')
  .option('--level <level>', `Filter by level (${LEVELS.join('|')})`)
  .option('--container <name>', `Which container (${CONTAINERS.join('|')})`, 'all')
  .option('--cursor <cursor>', 'Resume from a cursor returned by a previous call')
  .action(async (nameOrId: string, opts: Record<string, string>) => {
    assertOneOf('level', opts.level, LEVELS);
    assertOneOf('container', opts.container, CONTAINERS);

    const api = await ApiClient.create();
    const container = await resolveContainer(api, nameOrId);

    const params = new URLSearchParams();
    if (opts.since) params.set('since', parseSince(opts.since));
    if (opts.limit) params.set('limit', opts.limit);
    if (opts.level) params.set('level', opts.level);
    if (opts.container) params.set('container', opts.container);
    if (opts.cursor) params.set('cursor', opts.cursor);

    const query = params.toString();
    const res = await api.get<Envelope<{ available: boolean; entries: Array<Record<string, string>> }>>(
      `/api/v1/serverless/${container.id}/logs${query ? `?${query}` : ''}`,
    );

    if (isJsonMode()) {
      // Emit the envelope verbatim: availability, cursor and retention are
      // exactly what a caller needs to page correctly and to tell an empty
      // stream apart from an unreachable backend.
      jsonEnvelope(res.data, { error: res.error ?? null, meta: res.meta ?? {} });
      return;
    }

    if (!res.data.available) {
      console.error(chalk.yellow('Logs are currently unavailable. This says nothing about the container itself.'));
      return;
    }

    if (res.data.entries.length === 0) {
      console.log(chalk.dim('No log entries in this window.'));
      return;
    }

    for (const entry of res.data.entries) {
      const level = (entry.level || 'INFO').toUpperCase();
      const colour = level === 'ERROR' ? chalk.red : level === 'WARN' ? chalk.yellow : chalk.dim;
      console.log(`${chalk.dim(entry.timestamp)} ${colour(level.padEnd(5))} ${sanitize(entry.message ?? '')}`);
    }

    const cursor = res.meta?.next_cursor;
    if (typeof cursor === 'string' && cursor !== '') {
      console.log(chalk.dim(`\nMore entries available — resume with --cursor ${cursor}`));
    }
  });

const revisionsCommand = new Command('revisions')
  .description('List Knative revisions and their conditions')
  .argument('<name-or-id>', 'Container name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const container = await resolveContainer(api, nameOrId);

    const res = await api.get<Envelope<{
      available: boolean;
      revisions: Array<Record<string, unknown>>;
      service: Record<string, unknown> | null;
      route: Record<string, unknown> | null;
    }>>(`/api/v1/serverless/${container.id}/revisions`);

    if (isJsonMode()) {
      jsonEnvelope(res.data, { error: res.error ?? null, meta: res.meta ?? {} });
      return;
    }

    if (!res.data.available) {
      console.error(chalk.yellow('Revision information is currently unavailable.'));
      return;
    }

    for (const revision of res.data.revisions) {
      const markers = [
        revision.is_latest_ready ? chalk.green('serving') : null,
        revision.is_latest_created ? chalk.cyan('latest') : null,
      ].filter(Boolean).join(' ');

      console.log(`\n${chalk.bold(String(revision.name))} ${markers}`);
      console.log(chalk.dim(`  replicas: ${revision.actual_replicas ?? 0}/${revision.desired_replicas ?? 0}`));

      for (const condition of (revision.conditions as Array<Record<string, string>>) ?? []) {
        // Tri-state, not a boolean: `Unknown` means "still rolling out", which
        // is not a failure and must not be rendered as one.
        const status = condition.status ?? 'Unknown';
        const colour = status === 'True' ? chalk.green : status === 'False' ? chalk.red : chalk.yellow;
        const reason = condition.reason ? ` (${condition.reason})` : '';
        console.log(`  ${colour(status.padEnd(7))} ${condition.type}${chalk.dim(reason)}`);
        if (condition.message) {
          console.log(chalk.dim(`          ${sanitize(condition.message)}`));
        }
      }
    }
  });

const eventsCommand = new Command('events')
  .description('List platform events for a rapids container')
  .argument('<name-or-id>', 'Container name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const container = await resolveContainer(api, nameOrId);

    const res = await api.get<Envelope<{ available: boolean; events: Array<Record<string, unknown>> }>>(
      `/api/v1/serverless/${container.id}/events`,
    );

    if (isJsonMode()) {
      jsonEnvelope(res.data, { error: res.error ?? null, meta: res.meta ?? {} });
      return;
    }

    if (!res.data.available) {
      console.error(chalk.yellow('Events are currently unavailable. Try `danube rapids revisions` — conditions are the more reliable signal.'));
      return;
    }

    if (res.data.events.length === 0) {
      console.log(chalk.dim('No recent events. Platform events are short-lived, so this is not proof that nothing happened.'));
      return;
    }

    for (const event of res.data.events) {
      const colour = event.type === 'Warning' ? chalk.yellow : chalk.dim;
      const resource = event.resource as { kind?: string; name?: string } | undefined;
      const count = Number(event.count ?? 1);
      console.log(
        `${chalk.dim(String(event.last_seen ?? ''))} ${colour(String(event.reason ?? ''))} ` +
        `${chalk.dim(`${resource?.kind ?? ''}/${resource?.name ?? ''}`)}${count > 1 ? chalk.dim(` x${count}`) : ''}`,
      );
      console.log(`  ${sanitize(String(event.message ?? ''))}`);
    }
  });

export { logsCommand, revisionsCommand, eventsCommand };
