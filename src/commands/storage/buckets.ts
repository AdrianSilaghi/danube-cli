import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { input, select, confirm } from '@inquirer/prompts';
import { ApiClient } from '../../lib/api-client.js';
import { fetchAllPages } from '../../lib/paginate.js';
import { formatTable, statusColor, formatBytes, formatDate, formatNumber, formatRelativeTime } from '../../lib/output.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import type {
  StorageBucket,
  StorageMetrics,
  BucketTrendResponse,
  BucketTopObjectsResponse,
  BucketHealthResponse,
  MessageWithDataResponse,
  MessageResponse,
} from '../../types/api.js';

function freshnessBadge(f: string | null | undefined): string {
  switch (f) {
    case 'fresh':   return chalk.green('● Fresh');
    case 'lagging': return chalk.yellow('● Lagging');
    case 'stale':   return chalk.red('● Stale');
    default:        return chalk.dim('● No data');
  }
}

function formatPct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return chalk.dim('—');
  return `${(v * 100).toFixed(digits)}%`;
}

function formatMs(v: number | null | undefined): string {
  if (v === null || v === undefined) return chalk.dim('—');
  if (v >= 1000) return `${(v / 1000).toFixed(2)}s`;
  return `${Math.round(v)}ms`;
}

function parseSize(input: string): number {
  const match = input.trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/i);
  if (!match) return parseInt(input, 10);
  const num = parseFloat(match[1]!);
  const unit = (match[2] || 'B').toUpperCase();
  const multipliers: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Math.round(num * (multipliers[unit] ?? 1));
}

const lsCommand = new Command('ls')
  .description('List all buckets')
  .action(async () => {
    const api = await ApiClient.create();
    const { items, total, truncated } = await fetchAllPages<StorageBucket>(api, '/api/v1/storage/buckets');

    if (isJsonMode()) {
      jsonOutput(items);
      return;
    }

    if (items.length === 0) {
      console.log('No buckets found.');
      return;
    }

    const rows = items.map(b => [
      b.id,
      b.minio_bucket_name ?? b.name,
      b.name,
      statusColor(b.status),
      b.region,
      formatBytes(b.size_bytes ?? 0),
      String(b.object_count ?? 0),
      formatDate(b.created_at),
    ]);

    console.log(formatTable(['ID', 'BUCKET', 'NAME', 'STATUS', 'REGION', 'SIZE', 'OBJECTS', 'CREATED'], rows));

    if (truncated) {
      console.log(chalk.dim(`Showing ${items.length} of ${total}. Refine with the web console for the full list.`));
    }
  });

const createCommand = new Command('create')
  .description('Create a new bucket')
  .option('--name <name>', 'Bucket name')
  .option('--region <region>', 'Region')
  .option('--versioning', 'Enable versioning')
  .option('--public', 'Enable public access')
  .action(async (opts: { name?: string; region?: string; versioning?: boolean; public?: boolean }) => {
    let name = opts.name;
    let region = opts.region;
    let versioning = opts.versioning;
    let isPublic = opts.public;

    if (!name) {
      name = await input({
        message: 'Bucket name:',
        validate: (v: string) => v.trim().length > 0 || 'Name is required',
      });
    }

    if (!region) {
      region = await select({
        message: 'Region:',
        choices: [{ name: 'Falkenstein, Germany (fsn1)', value: 'fsn1' }],
      });
    }

    if (versioning === undefined && !isJsonMode()) {
      versioning = await confirm({ message: 'Enable versioning?', default: false });
    }

    if (isPublic === undefined && !isJsonMode()) {
      isPublic = await confirm({ message: 'Enable public access?', default: false });
    }

    const api = await ApiClient.create();
    const spinner = isJsonMode() ? null : ora('Creating bucket...').start();

    const res = await api.post<{ message: string; bucket: StorageBucket }>('/api/v1/storage/buckets', {
      name: name.trim(),
      region,
      versioning_enabled: versioning ?? false,
      public_access: isPublic ?? false,
    });

    if (isJsonMode()) {
      jsonOutput(res.bucket);
      return;
    }
    spinner!.succeed(`Created bucket ${chalk.bold(res.bucket.name)}`);
  });

const getCommand = new Command('get')
  .description('Show bucket details')
  .argument('<bucket-id>', 'Bucket ID')
  .action(async (bucketId: string) => {
    const api = await ApiClient.create();
    const res = await api.get<{ bucket: StorageBucket }>(`/api/v1/storage/buckets/${bucketId}`);

    if (isJsonMode()) {
      jsonOutput(res.bucket);
      return;
    }

    const b = res.bucket;

    const lines = [
      ['ID', b.id],
      ['Bucket', b.minio_bucket_name ?? b.name],
      ['Name', b.name],
      ['Status', statusColor(b.status)],
      ['Region', b.region],
      ['Endpoint', b.endpoint || '-'],
      ['Public Access', b.public_access ? chalk.yellow('yes') : 'no'],
      ['Versioning', b.versioning_enabled ? 'enabled' : 'disabled'],
      ['Encryption', b.encryption_enabled ? 'enabled' : 'disabled'],
      ['Size', formatBytes(b.size_bytes ?? 0)],
      ['Objects', String(b.object_count ?? 0)],
      ['Size Limit', b.size_limit_bytes ? formatBytes(b.size_limit_bytes) : 'none'],
      ['Cost', `\u20AC${b.monthly_cost_dollars ?? '0.00'}/mo`],
      ['Created', formatDate(b.created_at)],
    ];

    const maxLabel = Math.max(...lines.map(([l]) => l!.length));
    for (const [label, value] of lines) {
      console.log(`${chalk.dim(label!.padEnd(maxLabel))}  ${value}`);
    }
  });

const updateCommand = new Command('update')
  .description('Update bucket settings')
  .argument('<bucket-id>', 'Bucket ID')
  .option('--display-name <name>', 'Set display name')
  .option('--versioning', 'Enable versioning')
  .option('--no-versioning', 'Disable versioning')
  .option('--public', 'Enable public access')
  .option('--no-public', 'Disable public access')
  .option('--encryption', 'Enable encryption (SSE-S3)')
  .option('--no-encryption', 'Disable encryption')
  .option('--size-limit <size>', 'Set size limit (e.g. 1GB, 500MB, 1073741824)')
  .action(async (bucketId: string, opts: { displayName?: string; versioning?: boolean; public?: boolean; encryption?: boolean; sizeLimit?: string }) => {
    const body: Record<string, unknown> = {};

    if (opts.displayName !== undefined) body.display_name = opts.displayName;
    if (opts.versioning !== undefined) body.versioning_enabled = opts.versioning;
    if (opts.public !== undefined) body.public_access = opts.public;
    if (opts.encryption !== undefined) {
      body.encryption_enabled = opts.encryption;
      if (opts.encryption) body.encryption_type = 'sse-s3';
      else body.encryption_type = 'none';
    }
    if (opts.sizeLimit !== undefined) body.size_limit_bytes = parseSize(opts.sizeLimit);

    if (Object.keys(body).length === 0) {
      console.error(chalk.red('At least one option is required.'));
      process.exit(1);
    }

    const api = await ApiClient.create();
    const spinner = isJsonMode() ? null : ora('Updating bucket...').start();

    const res = await api.put<{ message: string; bucket: StorageBucket }>(`/api/v1/storage/buckets/${bucketId}`, body);

    if (isJsonMode()) {
      jsonOutput(res.bucket);
      return;
    }
    spinner!.succeed(`Updated bucket ${chalk.bold(res.bucket.name)}`);
  });

const deleteCommand = new Command('delete')
  .description('Delete a bucket')
  .argument('<bucket-id>', 'Bucket ID')
  .option('--force', 'Skip confirmation')
  .action(async (bucketId: string, opts: { force?: boolean }) => {
    if (!opts.force && !isJsonMode()) {
      const confirmed = await confirm({ message: `Are you sure you want to delete bucket ${bucketId}?`, default: false });
      if (!confirmed) {
        console.log('Cancelled.');
        return;
      }
    }

    const api = await ApiClient.create();
    const spinner = isJsonMode() ? null : ora('Deleting bucket...').start();

    await api.delete<MessageResponse>(`/api/v1/storage/buckets/${bucketId}`);

    if (isJsonMode()) {
      jsonOutput({ status: 'deleted', id: bucketId });
      return;
    }
    spinner!.succeed('Bucket deleted');
  });

const metricsShowCommand = new Command('show')
  .description('Show current bucket metrics snapshot (default action for `metrics`)')
  .argument('<bucket-id>', 'Bucket ID')
  .action(async (bucketId: string) => {
    const api = await ApiClient.create();
    const m = await api.get<StorageMetrics>(`/api/v1/storage/buckets/${bucketId}/metrics`);

    if (isJsonMode()) {
      jsonOutput(m);
      return;
    }

    const requestsCell = m.requests_24h == null
      ? chalk.dim('—')
      : (() => {
          const bd = m.requests_24h_by_method;
          const breakdown = bd
            ? chalk.dim(`  GET ${formatNumber(bd.GET)} · PUT ${formatNumber(bd.PUT)} · DEL ${formatNumber(bd.DELETE)} · HEAD ${formatNumber(bd.HEAD)}`)
            : '';
          return `${formatNumber(m.requests_24h)}${breakdown}`;
        })();

    const errorsCell = (() => {
      if (m.error_rate_24h === null || m.error_rate_24h === undefined) return chalk.dim('—');
      const bd = m.requests_24h_by_status;
      const breakdown = bd
        ? chalk.dim(`  2xx ${formatNumber(bd['2xx'])} · 4xx ${formatNumber(bd['4xx'])} · 5xx ${formatNumber(bd['5xx'])}`)
        : '';
      return `${formatPct(m.error_rate_24h)}${breakdown}`;
    })();

    const latencyCell = (() => {
      if (!m.latency_24h_ms) return chalk.dim('—');
      const parts: string[] = [];
      if (m.latency_24h_ms.p50 !== null && m.latency_24h_ms.p50 !== undefined) parts.push(`p50 ${formatMs(m.latency_24h_ms.p50)}`);
      if (m.latency_24h_ms.p95 !== null && m.latency_24h_ms.p95 !== undefined) parts.push(`p95 ${formatMs(m.latency_24h_ms.p95)}`);
      if (m.latency_24h_ms.mean !== null && m.latency_24h_ms.mean !== undefined) parts.push(`mean ${formatMs(m.latency_24h_ms.mean)}`);
      return parts.length ? parts.join(' · ') : chalk.dim('—');
    })();

    const lines: [string, string][] = [
      ['Size', m.size_human ?? formatBytes(m.size_bytes ?? 0)],
      ['Objects', formatNumber(m.object_count ?? 0)],
      ['Requests (24h)', requestsCell],
      ['Errors   (24h)', errorsCell],
      ['Latency  (24h)', latencyCell],
      ['Egress   (24h)', m.egress_human_24h ?? formatBytes(m.egress_bytes_24h ?? 0)],
    ];
    if (m.ingress_bytes_24h !== null && m.ingress_bytes_24h !== undefined) {
      lines.push(['Ingress  (24h)', m.ingress_human_24h ?? formatBytes(m.ingress_bytes_24h)]);
    }
    lines.push(
      ['Monthly Cost', `\u20AC${m.monthly_cost_dollars ?? '0.00'}`],
      ['Last Synced', `${formatRelativeTime(m.last_sync_at ?? (m as { last_synced_at?: string | null }).last_synced_at ?? null)}    ${freshnessBadge(m.freshness)}`],
    );

    const maxLabel = Math.max(...lines.map(([l]) => l!.length));
    for (const [label, value] of lines) {
      console.log(`${chalk.dim(label!.padEnd(maxLabel))}  ${value}`);
    }

    if (m.freshness === 'stale') process.exitCode = 3;
  });

const trendCommand = new Command('trend')
  .description('Show bucket metrics trend (time-series)')
  .argument('<bucket-id>', 'Bucket ID')
  .option('-w, --window <window>', 'Window: 24h | 7d | 30d', '24h')
  .option('-r, --resolution <resolution>', 'Resolution: 1m | 5m | 1h | 1d (auto by default)')
  .option('-f, --format <format>', 'Output format: sparkline | table | csv | json', 'sparkline')
  .action(async (bucketId: string, opts: { window: string; resolution?: string; format: string }) => {
    const api = await ApiClient.create();
    const params: Record<string, string> = { window: opts.window };
    if (opts.resolution) params.resolution = opts.resolution;

    const qs = new URLSearchParams(params).toString();
    const t = await api.get<BucketTrendResponse>(`/api/v1/storage/buckets/${bucketId}/metrics/trend?${qs}`);

    // Exit code 3 on stale data is set regardless of output format so
    // scripts/agents that pipe the output (csv/table) can still branch
    // on staleness without parsing the body.
    if (t.freshness === 'stale') process.exitCode = 3;

    if (isJsonMode() || opts.format === 'json') {
      jsonOutput(t);
      return;
    }

    const totals = t.data.reduce(
      (acc, r) => {
        if (r.requests.total !== null) acc.total += r.requests.total;
        acc.egress += r.egress_bytes;
        if (r.ingress_bytes !== null) acc.ingress += r.ingress_bytes;
        if (r.status) {
          acc.s2xx += r.status['2xx'] ?? 0;
          acc.s4xx += r.status['4xx'] ?? 0;
          acc.s5xx += r.status['5xx'] ?? 0;
        }
        return acc;
      },
      { total: 0, egress: 0, ingress: 0, s2xx: 0, s4xx: 0, s5xx: 0 },
    );

    const n = t.data.length;

    console.log(chalk.bold(`Trend for ${bucketId}  (${t.window} @ ${t.resolution}, source=${t.source})  ${freshnessBadge(t.freshness)}`));
    console.log(chalk.dim(`${n} datapoints, generated at ${t.generated_at}`));
    console.log('');

    if (n === 0) {
      console.log(chalk.dim('No data points in this window.'));
      return;
    }

    if (opts.format === 'csv') {
      console.log('recorded_at,size_bytes,object_count,requests_total,egress_bytes,ingress_bytes,error_rate,p95_ms');
      for (const r of t.data) {
        console.log([
          r.recorded_at,
          r.size_bytes,
          r.object_count,
          r.requests.total ?? '',
          r.egress_bytes,
          r.ingress_bytes ?? '',
          r.error_rate ?? '',
          r.latency_ms.p95 ?? '',
        ].join(','));
      }
      return;
    }

    if (opts.format === 'table') {
      for (const r of t.data) {
        console.log(
          `${chalk.dim(r.recorded_at)}  req=${String(r.requests.total ?? '-').padStart(6)}  egress=${formatBytes(r.egress_bytes).padStart(10)}  p95=${formatMs(r.latency_ms.p95).padStart(8)}  err=${formatPct(r.error_rate, 1).padStart(6)}`,
        );
      }
      return;
    }

    // sparkline (default)
    const spark = (values: Array<number | null>) => {
      const blocks = '▁▂▃▄▅▆▇█';
      const nums = values.filter((v) => v !== null && Number.isFinite(v)) as number[];
      if (nums.length === 0) return chalk.dim('—');
      const max = Math.max(...nums);
      const min = Math.min(...nums);
      const range = max - min || 1;
      return values
        .map((v) => {
          if (v === null || !Number.isFinite(v)) return ' ';
          const idx = Math.round(((v - min) / range) * (blocks.length - 1));
          return blocks[idx];
        })
        .join('');
    };

    const requestsSeries = t.data.map((r) => r.requests.total);
    const egressSeries = t.data.map((r) => r.egress_bytes);
    // latency_ms.p95 is the legacy name; the new API returns p95_upper_bound
    // for rollup responses. Accept either to stay forward-compatible.
    const p95Series: Array<number | null> = t.data.map((r) => r.latency_ms.p95 ?? r.latency_ms.p95_upper_bound ?? null);
    const errSeries = t.data.map((r) => r.error_rate);

    const lines: [string, string, string][] = [
      ['Requests', spark(requestsSeries), `total ${formatNumber(totals.total)}`],
      ['Egress', spark(egressSeries), `${formatBytes(totals.egress)}`],
      ['Latency p95', spark(p95Series), ''],
      ['Error rate', spark(errSeries), `2xx ${formatNumber(totals.s2xx)} · 4xx ${formatNumber(totals.s4xx)} · 5xx ${formatNumber(totals.s5xx)}`],
    ];

    const maxLabel = Math.max(...lines.map(([l]) => l.length));
    for (const [label, sp, suffix] of lines) {
      console.log(`${chalk.dim(label.padEnd(maxLabel))}  ${sp}  ${chalk.dim(suffix)}`);
    }
  });

const topCommand = new Command('top')
  .description('Top-N objects in a bucket by size / egress / requests')
  .argument('<bucket-id>', 'Bucket ID')
  .option('-b, --by <dimension>', 'Dimension: size | egress | requests', 'size')
  .option('-l, --limit <n>', 'Number of objects to return', '10')
  .action(async (bucketId: string, opts: { by: string; limit: string }) => {
    const api = await ApiClient.create();
    const qs = new URLSearchParams({ dimension: opts.by, limit: opts.limit }).toString();
    const res = await api.get<BucketTopObjectsResponse>(`/api/v1/storage/buckets/${bucketId}/metrics/top-objects?${qs}`);

    if (isJsonMode()) {
      jsonOutput(res);
      return;
    }

    if (res.items.length === 0) {
      console.log(chalk.dim('No top-objects data available yet for this bucket/dimension.'));
      process.exitCode = 3;
      return;
    }

    console.log(chalk.bold(`Top ${res.items.length} objects in ${bucketId} by ${res.dimension}`));
    if (res.recorded_at) console.log(chalk.dim(`Snapshot: ${res.recorded_at}`));
    console.log('');

    const fmt = opts.by === 'requests' ? formatNumber : formatBytes;
    const maxKeyLen = Math.min(80, Math.max(...res.items.map((i) => i.object_key.length)));
    for (const it of res.items) {
      const keyTrunc = it.object_key.length > 80 ? it.object_key.slice(0, 77) + '…' : it.object_key;
      console.log(`${chalk.dim(String(it.rank).padStart(2))}  ${keyTrunc.padEnd(maxKeyLen)}  ${fmt(it.value).padStart(12)}`);
    }
  });

const healthCommand = new Command('health')
  .description('Show bucket hygiene (pending multipart, deleted versions, last check)')
  .argument('<bucket-id>', 'Bucket ID')
  .action(async (bucketId: string) => {
    const api = await ApiClient.create();
    const h = await api.get<BucketHealthResponse>(`/api/v1/storage/buckets/${bucketId}/metrics/health`);

    if (isJsonMode()) {
      jsonOutput(h);
      if (h.freshness === 'stale') process.exitCode = 3;
      return;
    }

    const pending = h.pending_multipart_count === null
      ? chalk.dim('—')
      : `${formatNumber(h.pending_multipart_count)}${h.pending_multipart_bytes !== null ? chalk.dim(`  (${formatBytes(h.pending_multipart_bytes)} reclaimable)`) : ''}`;

    const deleted = h.deleted_size_bytes === null
      ? chalk.dim('—')
      : formatBytes(h.deleted_size_bytes);

    const lines: [string, string][] = [
      ['Pending multipart', pending],
      ['Deleted versions', deleted],
      ['Metrics updated', `${formatRelativeTime(h.metrics_precomputed_at)}    ${freshnessBadge(h.freshness)}`],
      ['Last health check', formatRelativeTime(h.last_health_check_at)],
      ['Health status', h.health_check_status ?? chalk.dim('—')],
    ];

    const maxLabel = Math.max(...lines.map(([l]) => l.length));
    for (const [label, value] of lines) {
      console.log(`${chalk.dim(label.padEnd(maxLabel))}  ${value}`);
    }

    if (h.freshness === 'stale') process.exitCode = 3;
  });

// Parent `metrics` command — default action runs the show subcommand so
// `danube storage buckets metrics <id>` keeps working as before.
const metricsCommand = new Command('metrics')
  .description('Bucket metrics (snapshot + trend + top-objects + health)')
  .argument('[bucket-id]', 'Bucket ID (runs the `show` subcommand)')
  .action(async (bucketId: string | undefined, _opts: unknown, cmd: Command) => {
    if (!bucketId) {
      cmd.help();
      return;
    }
    await metricsShowCommand.parseAsync([bucketId], { from: 'user' });
  })
  .addCommand(metricsShowCommand)
  .addCommand(trendCommand)
  .addCommand(topCommand)
  .addCommand(healthCommand);

export const bucketsCommand = new Command('buckets')
  .description('Manage storage buckets')
  .addCommand(lsCommand)
  .addCommand(createCommand)
  .addCommand(getCommand)
  .addCommand(updateCommand)
  .addCommand(deleteCommand)
  .addCommand(metricsCommand);
