import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { input, confirm } from '@inquirer/prompts';
import { ApiClient } from '../../lib/api-client.js';
import { formatTable, statusColor, formatDate } from '../../lib/output.js';
import type {
  StorageAccessKey,
  CreateAccessKeyResponse,
  PaginatedResponse,
  MessageResponse,
} from '../../types/api.js';

const lsCommand = new Command('ls')
  .description('List all access keys')
  .action(async () => {
    const api = await ApiClient.create();
    const res = await api.get<PaginatedResponse<StorageAccessKey>>('/api/v1/storage/access-keys');

    if (res.data.length === 0) {
      console.log('No access keys found.');
      return;
    }

    const rows = res.data.map(k => [
      k.name,
      k.access_key_id,
      statusColor(k.status),
      k.expires_at ? formatDate(k.expires_at) : 'never',
      k.last_used_at ? formatDate(k.last_used_at) : '-',
      formatDate(k.created_at),
    ]);

    console.log(formatTable(['NAME', 'ACCESS KEY', 'STATUS', 'EXPIRES', 'LAST USED', 'CREATED'], rows));
  });

const createCommand = new Command('create')
  .description('Create a new access key')
  .option('--name <name>', 'Key name')
  .option('--expires <date>', 'Expiration date (ISO 8601)')
  .action(async (opts: { name?: string; expires?: string }) => {
    let name = opts.name;

    if (!name) {
      name = await input({
        message: 'Access key name:',
        validate: (v: string) => v.trim().length > 0 || 'Name is required',
      });
    }

    const body: Record<string, unknown> = { name: name.trim() };
    if (opts.expires) body.expires_at = opts.expires;

    const api = await ApiClient.create();
    const spinner = ora('Creating access key...').start();

    const res = await api.post<CreateAccessKeyResponse>('/api/v1/storage/access-keys', body);
    spinner.succeed(`Created access key ${chalk.bold(res.name)}`);

    console.log('');
    console.log(`  Access Key ID:     ${chalk.bold(res.access_key_id)}`);
    console.log(`  Secret Access Key: ${chalk.bold.yellow(res.secret_access_key)}`);
    console.log('');
    console.log(chalk.yellow('  Save the secret access key now — it will not be shown again.'));
  });

const getCommand = new Command('get')
  .description('Show access key details')
  .argument('<key-id>', 'Access key ID')
  .action(async (keyId: string) => {
    const api = await ApiClient.create();
    const res = await api.get<{ access_key: StorageAccessKey }>(`/api/v1/storage/access-keys/${keyId}`);
    const k = res.access_key;

    const lines = [
      ['Name', k.name],
      ['Access Key ID', k.access_key_id],
      ['Status', statusColor(k.status)],
      ['Expires', k.expires_at ? formatDate(k.expires_at) : 'never'],
      ['Last Used', k.last_used_at ? formatDate(k.last_used_at) : '-'],
      ['Created', formatDate(k.created_at)],
    ];

    const maxLabel = Math.max(...lines.map(([l]) => l!.length));
    for (const [label, value] of lines) {
      console.log(`${chalk.dim(label!.padEnd(maxLabel))}  ${value}`);
    }
  });

const revokeCommand = new Command('revoke')
  .description('Revoke an access key')
  .argument('<key-id>', 'Access key ID')
  .option('--force', 'Skip confirmation')
  .action(async (keyId: string, opts: { force?: boolean }) => {
    if (!opts.force) {
      const confirmed = await confirm({ message: `Are you sure you want to revoke access key ${keyId}?`, default: false });
      if (!confirmed) {
        console.log('Cancelled.');
        return;
      }
    }

    const api = await ApiClient.create();
    const spinner = ora('Revoking access key...').start();

    await api.delete<MessageResponse>(`/api/v1/storage/access-keys/${keyId}`);
    spinner.succeed('Access key revoked');
  });

export const keysCommand = new Command('keys')
  .description('Manage storage access keys')
  .addCommand(lsCommand)
  .addCommand(createCommand)
  .addCommand(getCommand)
  .addCommand(revokeCommand);
