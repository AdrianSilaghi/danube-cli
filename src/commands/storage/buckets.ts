import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { input, select, confirm } from '@inquirer/prompts';
import { ApiClient } from '../../lib/api-client.js';
import { formatTable, statusColor, formatBytes, formatDate } from '../../lib/output.js';
import type {
  StorageBucket,
  StorageMetrics,
  PaginatedResponse,
  MessageWithDataResponse,
  MessageResponse,
} from '../../types/api.js';

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
    const res = await api.get<PaginatedResponse<StorageBucket>>('/api/v1/storage/buckets');

    if (res.data.length === 0) {
      console.log('No buckets found.');
      return;
    }

    const rows = res.data.map(b => [
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

    if (versioning === undefined) {
      versioning = await confirm({ message: 'Enable versioning?', default: false });
    }

    if (isPublic === undefined) {
      isPublic = await confirm({ message: 'Enable public access?', default: false });
    }

    const api = await ApiClient.create();
    const spinner = ora('Creating bucket...').start();

    const res = await api.post<{ message: string; bucket: StorageBucket }>('/api/v1/storage/buckets', {
      name: name.trim(),
      region,
      versioning_enabled: versioning,
      public_access: isPublic,
    });

    spinner.succeed(`Created bucket ${chalk.bold(res.bucket.name)}`);
  });

const getCommand = new Command('get')
  .description('Show bucket details')
  .argument('<bucket-id>', 'Bucket ID')
  .action(async (bucketId: string) => {
    const api = await ApiClient.create();
    const res = await api.get<{ bucket: StorageBucket }>(`/api/v1/storage/buckets/${bucketId}`);
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
    const spinner = ora('Updating bucket...').start();

    const res = await api.put<{ message: string; bucket: StorageBucket }>(`/api/v1/storage/buckets/${bucketId}`, body);
    spinner.succeed(`Updated bucket ${chalk.bold(res.bucket.name)}`);
  });

const deleteCommand = new Command('delete')
  .description('Delete a bucket')
  .argument('<bucket-id>', 'Bucket ID')
  .option('--force', 'Skip confirmation')
  .action(async (bucketId: string, opts: { force?: boolean }) => {
    if (!opts.force) {
      const confirmed = await confirm({ message: `Are you sure you want to delete bucket ${bucketId}?`, default: false });
      if (!confirmed) {
        console.log('Cancelled.');
        return;
      }
    }

    const api = await ApiClient.create();
    const spinner = ora('Deleting bucket...').start();

    await api.delete<MessageResponse>(`/api/v1/storage/buckets/${bucketId}`);
    spinner.succeed('Bucket deleted');
  });

const metricsCommand = new Command('metrics')
  .description('Show bucket metrics')
  .argument('<bucket-id>', 'Bucket ID')
  .action(async (bucketId: string) => {
    const api = await ApiClient.create();
    const m = await api.get<StorageMetrics>(`/api/v1/storage/buckets/${bucketId}/metrics`);

    const lines = [
      ['Size', formatBytes(m.size_bytes ?? 0)],
      ['Objects', String(m.object_count ?? 0)],
      ['Monthly Cost', `\u20AC${m.monthly_cost_dollars ?? '0.00'}`],
      ['Last Synced', m.last_synced_at ? formatDate(m.last_synced_at) : '-'],
    ];

    const maxLabel = Math.max(...lines.map(([l]) => l!.length));
    for (const [label, value] of lines) {
      console.log(`${chalk.dim(label!.padEnd(maxLabel))}  ${value}`);
    }
  });

export const bucketsCommand = new Command('buckets')
  .description('Manage storage buckets')
  .addCommand(lsCommand)
  .addCommand(createCommand)
  .addCommand(getCommand)
  .addCommand(updateCommand)
  .addCommand(deleteCommand)
  .addCommand(metricsCommand);
