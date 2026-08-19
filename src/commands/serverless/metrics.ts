import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { resolveContainer } from './resolve.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import { formatTable, statusColor, printDetails } from '../../lib/output.js';
import { formatCores, formatBytesBinary } from '../../lib/units.js';
import { ApiError, UsageError } from '../../lib/errors.js';
import type { MetricSeries, ServerlessMetricsCurrent, ServerlessMetricsResponse } from '../../types/api.js';

const HOURS_MIN = 1;
const HOURS_MAX = 720;

/** Mirrors the server-side `hours` validation, so a bad window fails before spending a request. */
function parseHours(raw: string): number {
  const hours = Number(raw);
  if (!Number.isInteger(hours) || hours < HOURS_MIN || hours > HOURS_MAX) {
    throw new UsageError(`Invalid --hours "${raw}". Expected an integer between ${HOURS_MIN} and ${HOURS_MAX}.`);
  }
  return hours;
}

/** 2-decimal display without trailing zeros: 12.34 → "12.34", 2 → "2". */
const num = (v: number): string => String(Number(v.toFixed(2)));

/**
 * Known series in render order, each with its unit. Units come from the
 * platform contract: cpu in cores, memory in bytes, latency in ms, requests
 * in req/s, errors in percent. Unknown keys the API may add later still
 * render (as bare numbers) — the API's series list is the truth, not this map.
 */
const SERIES_FORMATS: Array<{ key: string; fmt: (v: number) => string }> = [
  { key: 'requests', fmt: (v) => `${num(v)} req/s` },
  { key: 'latency', fmt: (v) => `${num(v)} ms` },
  { key: 'replicas', fmt: num },
  { key: 'cpu', fmt: formatCores },
  { key: 'memory', fmt: formatBytesBinary },
  { key: 'errors', fmt: (v) => `${num(v)}%` },
];

export const metricsCommand = new Command('metrics')
  .description('Show the CPU/memory/request metrics behind the console graphs')
  .argument('<name-or-id>', 'Container name or ID')
  .option('--hours <n>', `Window in hours (${HOURS_MIN}-${HOURS_MAX})`, '24')
  .action(async (nameOrId: string, opts: { hours: string }) => {
    const hours = parseHours(opts.hours);

    const api = await ApiClient.create();
    const container = await resolveContainer(api, nameOrId);

    let res: ServerlessMetricsResponse;
    try {
      res = await api.get<ServerlessMetricsResponse>(
        `/api/v1/serverless/${container.id}/metrics?hours=${hours}`,
      );
    } catch (err) {
      // Human mode gets a hint tuned to this endpoint; JSON mode keeps the
      // standard machine-readable error contract from the central handler.
      if (!isJsonMode()) explainMetricsFailure(err, container.name);
      throw err;
    }

    if (isJsonMode()) {
      // The API payload verbatim (inside the standard envelope), full raw
      // series included — same convention as the other rapids commands.
      jsonOutput(res);
      return;
    }

    render(res);
  });

/**
 * The controller builds `metrics` and `current` as PHP arrays, so both arrive
 * as `[]` rather than `{}` when empty. Normalize before reading.
 */
function seriesOf(res: ServerlessMetricsResponse): Record<string, MetricSeries | undefined> {
  return Array.isArray(res.metrics) ? {} : res.metrics;
}

function currentOf(res: ServerlessMetricsResponse): ServerlessMetricsCurrent {
  return Array.isArray(res.current) ? {} : res.current;
}

function render(res: ServerlessMetricsResponse): void {
  const c = res.container;
  console.log(
    `${chalk.bold(c.name)} (${c.resource_profile}, ${statusColor(c.status)})${chalk.dim(` — last ${res.period_hours}h`)}`,
  );
  console.log();

  const r = res.resources;
  const lines: Array<[string, string]> = [
    ['Allocated', `cpu ${r.cpu_request}–${r.cpu_limit} · memory ${r.memory_request}–${r.memory_limit}`],
  ];

  const live = liveLine(currentOf(res));
  if (live) lines.push(['Live', live]);
  printDetails(lines);

  console.log();
  console.log(formatTable(['SERIES', 'AVG', 'MAX', 'LATEST'], seriesRows(seriesOf(res))));
}

/** `2 pods · 250m cpu · 256 MiB memory · 42 req/5m`, from whichever fields exist. */
function liveLine(current: ServerlessMetricsCurrent): string | null {
  const parts: string[] = [];
  if (current.current_pods !== undefined) parts.push(`${current.current_pods} pod${current.current_pods === 1 ? '' : 's'}`);
  if (current.current_cpu !== undefined) parts.push(`${formatCores(current.current_cpu)} cpu`);
  if (current.current_memory !== undefined) parts.push(`${formatBytesBinary(current.current_memory)} memory`);
  if (current.request_count_5m !== undefined) parts.push(`${current.request_count_5m} req/5m`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function seriesRows(series: Record<string, MetricSeries | undefined>): string[][] {
  // Known series first, in stable order; anything new the API starts sending
  // renders after them rather than being dropped.
  const extras = Object.keys(series)
    .filter((key) => !SERIES_FORMATS.some((s) => s.key === key))
    .map((key) => ({ key, fmt: num }));

  return [...SERIES_FORMATS, ...extras].map(({ key, fmt }) => {
    const values = series[key]?.values ?? [];
    if (values.length === 0) {
      const noData = chalk.dim('no data');
      return [key, noData, noData, noData];
    }
    const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
    const max = Math.max(...values);
    const latest = values[values.length - 1]!;
    return [key, fmt(avg), fmt(max), fmt(latest)];
  });
}

/**
 * Friendly diagnosis for the failures an operator actually hits here.
 * Exits with the same codes the central handler uses, so scripts keep
 * meaning: 404 → 4, everything else → 1.
 */
function explainMetricsFailure(err: unknown, containerName: string): void {
  if (!(err instanceof ApiError)) return;

  if (err.statusCode === 403) {
    console.error(chalk.red('Your API token lacks the serverless:read ability.'));
    console.error(chalk.dim('Create a token that includes serverless:read and try again.'));
    process.exit(1);
  }

  if (err.statusCode === 429) {
    console.error(chalk.red('Rate limited: metrics share the diagnostics budget (60 requests/min per token, 180/min per team).'));
    console.error(chalk.dim('Responses are cached platform-side for 15s — polling faster than ~15s spends budget without fresher data.'));
    process.exit(1);
  }

  if (err.statusCode === 404) {
    // The container name just resolved via the list endpoint, so a 404 HERE
    // usually means the route itself is missing, not the container.
    console.error(chalk.red(`Container '${containerName}' was found, but its metrics endpoint returned 404.`));
    console.error(chalk.dim('Either the container was deleted just now, or this platform deployment predates the'));
    console.error(chalk.dim('metrics API (ships with danubedata#409). If `danube rapids get` works, it is the latter —'));
    console.error(chalk.dim('retry after the next platform deploy.'));
    process.exit(4);
  }
}
