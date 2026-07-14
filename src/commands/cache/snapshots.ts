import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client.js';
import { fetchAllPages } from '../../lib/paginate.js';
import { resolveResource } from '../../lib/resolve.js';
import { formatTable, statusColor, formatDate } from '../../lib/output.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import { confirmDestruction } from '../../lib/interactive.js';
import type { CacheSnapshot, CacheInstance } from '../../types/api.js';

const lsCommand = new Command('ls')
  .description('List cache snapshots')
  .option('--instance <name-or-id>', 'Filter by cache instance name or ID')
  .action(async (opts: { instance?: string }) => {
    const api = await ApiClient.create();
    const { items, total, truncated } = await fetchAllPages<CacheSnapshot>(api, '/api/v1/snapshots/cache');

    let rows = items;
    if (opts.instance) {
      const instance = await resolveResource<CacheInstance>(api, '/api/v1/cache', 'cache', opts.instance);
      rows = items.filter(s => s.cache_instance_id === instance.id);
    }

    if (isJsonMode()) {
      jsonOutput(rows);
      return;
    }

    if (rows.length === 0) {
      console.log('No cache snapshots found.');
      return;
    }

    console.log(formatTable(
      ['ID', 'NAME', 'INSTANCE', 'STATUS', 'SIZE', 'CREATED'],
      rows.map(s => [
        s.id,
        s.name,
        s.cache_instance?.name ?? s.cache_instance_id,
        statusColor(s.status),
        s.size_mb != null ? `${s.size_mb} MB` : '-',
        formatDate(s.created_at),
      ]),
    ));

    if (truncated) {
      console.log(chalk.dim(`Showing ${items.length} of ${total}. Refine with the web console for the full list.`));
    }
  });

const createCommand = new Command('create')
  .description('Create a cache snapshot')
  .argument('<name-or-id>', 'Cache instance name or ID')
  .option('--name <name>', 'Snapshot name')
  .option('--description <text>', 'Optional description')
  .action(async (nameOrId: string, opts: { name?: string; description?: string }) => {
    if (!opts.name) {
      console.error(chalk.red('--name is required.'));
      process.exit(1);
    }

    const api = await ApiClient.create();
    const instance = await resolveResource<CacheInstance>(api, '/api/v1/cache', 'cache', nameOrId);

    const body: Record<string, unknown> = {
      cache_instance_id: instance.id,
      name: opts.name,
    };
    if (opts.description) body.description = opts.description;

    const spinner = isJsonMode() ? null : ora('Creating snapshot...').start();
    const res = await api.post<{ message: string; snapshot: CacheSnapshot }>('/api/v1/snapshots/cache', body);

    if (isJsonMode()) {
      jsonOutput(res.snapshot);
      return;
    }
    spinner!.succeed(`Snapshot ${chalk.bold(res.snapshot.name)} (${res.snapshot.id}) creation initiated`);
  });

const restoreCommand = new Command('restore')
  .description('Restore a cache snapshot into its source instance')
  .argument('<snapshot-id>', 'Snapshot ID')
  .option('-f, --force', 'Skip confirmation')
  .option('-y, --yes', 'Alias for --force')
  .action(async (snapshotId: string, opts: { force?: boolean; yes?: boolean }) => {
    const proceed = await confirmDestruction(
      `restore of snapshot ${snapshotId}`,
      `Restore snapshot ${snapshotId}? This overwrites the current cache contents.`,
      opts.force || opts.yes,
    );
    if (!proceed) {
      console.log('Cancelled.');
      return;
    }

    const api = await ApiClient.create();
    const spinner = isJsonMode() ? null : ora('Restoring snapshot...').start();
    const res = await api.post<{ message: string }>(`/api/v1/snapshots/cache/${snapshotId}/restore`);

    if (isJsonMode()) {
      jsonOutput({ status: 'restoring', id: snapshotId, message: res.message });
      return;
    }
    spinner!.succeed(res.message || 'Restore initiated');
  });

const cloneCommand = new Command('clone')
  .description('Clone a cache snapshot into a new instance')
  .argument('<snapshot-id>', 'Snapshot ID')
  .option('--name <name>', 'Name for the new cloned instance')
  .option('--source-type <type>', 'volume_snapshot or velero_backup', 'volume_snapshot')
  .action(async (snapshotId: string, opts: { name?: string; sourceType: string }) => {
    if (!opts.name) {
      console.error(chalk.red('--name is required.'));
      process.exit(1);
    }
    if (!['volume_snapshot', 'velero_backup'].includes(opts.sourceType)) {
      console.error(chalk.red('--source-type must be volume_snapshot or velero_backup.'));
      process.exit(1);
    }

    const api = await ApiClient.create();
    const spinner = isJsonMode() ? null : ora('Cloning snapshot...').start();
    const res = await api.post<{ message: string; instance: CacheInstance }>(
      `/api/v1/snapshots/cache/${snapshotId}/clone`,
      { name: opts.name, source_type: opts.sourceType },
    );

    if (isJsonMode()) {
      jsonOutput(res.instance);
      return;
    }
    spinner!.succeed(`Clone ${chalk.bold(res.instance.name)} (${res.instance.id}) creation initiated`);
  });

const rmCommand = new Command('rm')
  .description('Delete a cache snapshot')
  .argument('<snapshot-id>', 'Snapshot ID')
  .option('-f, --force', 'Skip confirmation')
  .option('-y, --yes', 'Alias for --force')
  .action(async (snapshotId: string, opts: { force?: boolean; yes?: boolean }) => {
    const proceed = await confirmDestruction(
      `deletion of snapshot ${snapshotId}`,
      `Delete snapshot ${snapshotId}? This cannot be undone.`,
      opts.force || opts.yes,
    );
    if (!proceed) {
      console.log('Cancelled.');
      return;
    }

    const api = await ApiClient.create();
    const spinner = isJsonMode() ? null : ora('Deleting snapshot...').start();
    await api.delete<{ message: string }>(`/api/v1/snapshots/cache/${snapshotId}`);

    if (isJsonMode()) {
      jsonOutput({ status: 'deleting', id: snapshotId });
      return;
    }
    spinner!.succeed('Snapshot deletion initiated');
  });

export const snapshotsCommand = new Command('snapshots')
  .description('Manage cache snapshots')
  .addCommand(lsCommand)
  .addCommand(createCommand)
  .addCommand(restoreCommand)
  .addCommand(cloneCommand)
  .addCommand(rmCommand);
