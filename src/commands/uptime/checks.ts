import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { input, select } from '@inquirer/prompts';
import { ApiClient } from '../../lib/api-client.js';
import { fetchAllPages } from '../../lib/paginate.js';
import { resolveResource } from '../../lib/resolve.js';
import { formatTable, statusColor, formatDate, printDetails } from '../../lib/output.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import { promptOr, confirmDestruction } from '../../lib/interactive.js';
import type { UptimeCheck, UptimeCheckResponse } from '../../types/api.js';

export const BASE = '/api/v1/uptime-checks';

/** The API accepts only these two; anything else is a 422. */
const INTERVALS = [60, 300];
const METHODS = ['GET', 'HEAD'];

/**
 * `down` is not a red alert for the CHECK — the check is working, the target
 * is not. Colouring it like a failed instance would misread the whole
 * product, so the status stays plain and the URL carries the blame.
 */
export function checkStatus(check: UptimeCheck): string {
  if (check.status === 'down') return chalk.red('down');
  if (check.status === 'up') return chalk.green('up');
  if (check.status === 'paused') return chalk.dim('paused');
  return chalk.yellow('unknown');
}

export const lsCommand = new Command('ls')
  .description('List uptime checks')
  .action(async () => {
    const api = await ApiClient.create();
    const { items, total, truncated } = await fetchAllPages<UptimeCheck>(api, BASE);

    if (isJsonMode()) {
      jsonOutput(items);
      return;
    }

    if (items.length === 0) {
      console.log('No uptime checks found.');
      return;
    }

    const rows = items.map(c => [
      c.id,
      c.name,
      c.url,
      checkStatus(c),
      `${c.interval_seconds}s`,
      c.last_response_time_ms !== null ? `${c.last_response_time_ms}ms` : '-',
      c.last_error ?? '-',
      c.last_checked_at ? formatDate(c.last_checked_at) : 'never',
    ]);

    console.log(formatTable(
      ['ID', 'NAME', 'URL', 'STATUS', 'EVERY', 'LAST RT', 'LAST ERROR', 'CHECKED'],
      rows,
    ));

    if (truncated) {
      console.log(chalk.dim(`Showing ${items.length} of ${total}.`));
    }
  });

export const createCommand = new Command('create')
  .description('Create an uptime check')
  .option('--name <name>', 'Check name')
  .option('--url <url>', 'Target URL (http or https, public address only)')
  .option('--method <method>', 'GET or HEAD', 'GET')
  .option('--interval <seconds>', 'Check interval: 60 or 300')
  .option('--timeout <seconds>', 'Request timeout in seconds (1-30)')
  .option('--expected-status <expr>', 'Expected status: 2xx, 2xx-3xx, or exact:NNN')
  .option('--keyword <keyword>', 'Require this string in the response body (forces GET)')
  .option('--failure-threshold <n>', 'Consecutive failures before alerting (1-10)')
  .option('--no-verify-tls', 'Do not verify the TLS certificate')
  .option('--no-follow-redirects', 'Do not follow redirects')
  .action(async (opts: {
    name?: string; url?: string; method: string; interval?: string; timeout?: string;
    expectedStatus?: string; keyword?: string; failureThreshold?: string;
    verifyTls?: boolean; followRedirects?: boolean;
  }) => {
    if (!METHODS.includes(opts.method.toUpperCase())) {
      console.error(chalk.red(`Invalid method "${opts.method}". Valid: ${METHODS.join(', ')}`));
      process.exit(1);
    }

    const api = await ApiClient.create();

    const name = await promptOr('--name', opts.name, () => input({
      message: 'Check name:',
      validate: (v: string) => v.trim().length > 0 || 'Required',
    }));

    const url = await promptOr('--url', opts.url, () => input({
      message: 'URL to monitor:',
      validate: (v: string) => /^https?:\/\/.+/.test(v.trim()) || 'Must start with http:// or https://',
    }));

    const interval = opts.interval
      ? Number(opts.interval)
      : await promptOr('--interval', undefined, () => select({
        message: 'Check interval:',
        choices: INTERVALS.map(s => ({ name: s === 60 ? 'every minute' : 'every 5 minutes', value: s })),
      }));

    if (!INTERVALS.includes(interval)) {
      console.error(chalk.red(`Invalid interval "${interval}". Valid: ${INTERVALS.join(', ')} (seconds).`));
      process.exit(1);
    }

    const body: Record<string, unknown> = {
      name: name.trim(),
      url: url.trim(),
      method: opts.method.toUpperCase(),
      interval_seconds: interval,
    };
    if (opts.timeout !== undefined) body.timeout_seconds = Number(opts.timeout);
    if (opts.expectedStatus !== undefined) body.expected_status = opts.expectedStatus;
    if (opts.keyword !== undefined) body.body_keyword = opts.keyword;
    if (opts.failureThreshold !== undefined) body.failure_threshold = Number(opts.failureThreshold);
    // Commander sets these to false only when the --no- form was passed.
    if (opts.verifyTls === false) body.verify_tls = false;
    if (opts.followRedirects === false) body.follow_redirects = false;

    const spinner = isJsonMode() ? null : ora('Creating uptime check...').start();
    const res = await api.post<UptimeCheckResponse>(BASE, body);

    if (isJsonMode()) {
      jsonOutput(res.check);
      return;
    }

    spinner!.succeed(`Created uptime check ${chalk.bold(res.check.name)} (${res.check.id})`);
    // The check reports nothing until its first probe lands, and saying so
    // here stops "unknown" reading as "your site is broken".
    console.log(chalk.dim(
      `Watching ${res.check.url} every ${res.check.interval_seconds}s. First result within one interval.`,
    ));
  });

export const getCommand = new Command('get')
  .description('Show an uptime check')
  .argument('<name-or-id>', 'Check name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const check = await resolveResource<UptimeCheck>(api, BASE, 'uptime check', nameOrId);
    const res = await api.get<{ check: UptimeCheck }>(`${BASE}/${check.id}`);

    if (isJsonMode()) {
      jsonOutput(res.check);
      return;
    }

    const c = res.check;
    const lines: Array<[string, string]> = [
      ['ID', c.id],
      ['Name', c.name],
      ['URL', c.url],
      ['Method', c.method],
      ['Status', checkStatus(c)],
      ['Target health', c.status_details ? statusColor(c.status_details.health) : '-'],
      ['Enabled', c.enabled ? 'yes' : 'no (paused)'],
      ['Interval', `${c.interval_seconds}s`],
      ['Timeout', `${c.timeout_seconds}s`],
      ['Expected status', c.expected_status],
      ['Body keyword', c.body_keyword ?? '-'],
      ['Verify TLS', c.verify_tls ? 'yes' : 'no'],
      ['Follow redirects', c.follow_redirects ? 'yes' : 'no'],
      ['Failure threshold', String(c.failure_threshold)],
      ['Consecutive failures', String(c.consecutive_failures)],
      ['Last checked', c.last_checked_at ? formatDate(c.last_checked_at) : 'never'],
      ['Last status code', c.last_status_code !== null ? String(c.last_status_code) : '-'],
      ['Last response time', c.last_response_time_ms !== null ? `${c.last_response_time_ms}ms` : '-'],
      ['Last error', c.last_error ?? '-'],
      ['TLS expires', c.ssl_expires_at ? formatDate(c.ssl_expires_at) : '-'],
      ['Created', c.created_at ? formatDate(c.created_at) : '-'],
    ];

    printDetails(lines);
  });

export const updateCommand = new Command('update')
  .description('Update an uptime check')
  .argument('<name-or-id>', 'Check name or ID')
  .option('--name <name>', 'New name')
  .option('--url <url>', 'New target URL')
  .option('--method <method>', 'GET or HEAD')
  .option('--interval <seconds>', 'Check interval: 60 or 300')
  .option('--timeout <seconds>', 'Request timeout in seconds (1-30)')
  .option('--expected-status <expr>', 'Expected status: 2xx, 2xx-3xx, or exact:NNN')
  .option('--keyword <keyword>', 'Require this string in the response body')
  .option('--failure-threshold <n>', 'Consecutive failures before alerting (1-10)')
  .option('--verify-tls', 'Verify the TLS certificate')
  .option('--no-verify-tls', 'Do not verify the TLS certificate')
  .action(async (nameOrId: string, opts: {
    name?: string; url?: string; method?: string; interval?: string; timeout?: string;
    expectedStatus?: string; keyword?: string; failureThreshold?: string; verifyTls?: boolean;
  }) => {
    const body: Record<string, unknown> = {};
    if (opts.name !== undefined) body.name = opts.name;
    if (opts.url !== undefined) body.url = opts.url;
    if (opts.method !== undefined) body.method = opts.method.toUpperCase();
    if (opts.interval !== undefined) body.interval_seconds = Number(opts.interval);
    if (opts.timeout !== undefined) body.timeout_seconds = Number(opts.timeout);
    if (opts.expectedStatus !== undefined) body.expected_status = opts.expectedStatus;
    if (opts.keyword !== undefined) body.body_keyword = opts.keyword;
    if (opts.failureThreshold !== undefined) body.failure_threshold = Number(opts.failureThreshold);
    if (opts.verifyTls !== undefined) body.verify_tls = opts.verifyTls;

    if (Object.keys(body).length === 0) {
      console.error(chalk.red('At least one option is required.'));
      process.exit(1);
    }

    // `enabled` is deliberately not settable here — pausing has a side effect
    // (it closes any open incident), so it gets its own verb.
    const api = await ApiClient.create();
    const check = await resolveResource<UptimeCheck>(api, BASE, 'uptime check', nameOrId);
    const spinner = isJsonMode() ? null : ora('Updating uptime check...').start();
    const res = await api.put<UptimeCheckResponse>(`${BASE}/${check.id}`, body);

    if (isJsonMode()) {
      jsonOutput(res.check);
      return;
    }
    spinner!.succeed(`Updated uptime check ${chalk.bold(res.check.name)}`);
  });

export const rmCommand = new Command('rm')
  .alias('delete')
  .description('Delete an uptime check')
  .argument('<name-or-id>', 'Check name or ID')
  .option('-f, --force', 'Skip confirmation')
  .option('-y, --yes', 'Alias for --force')
  .action(async (nameOrId: string, opts: { force?: boolean; yes?: boolean }) => {
    const api = await ApiClient.create();
    const check = await resolveResource<UptimeCheck>(api, BASE, 'uptime check', nameOrId);

    const proceed = await confirmDestruction(
      `deletion of uptime check ${check.name}`,
      `Delete uptime check ${check.name} (${check.url})? Its outage history goes with it.`,
      opts.force || opts.yes,
    );
    if (!proceed) {
      console.log('Cancelled.');
      return;
    }

    const spinner = isJsonMode() ? null : ora('Deleting uptime check...').start();
    await api.delete<{ message: string }>(`${BASE}/${check.id}`);

    if (isJsonMode()) {
      jsonOutput({ deleted: true, id: check.id });
      return;
    }
    spinner!.succeed('Uptime check deleted');
  });
