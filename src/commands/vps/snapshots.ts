import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client.js';
import { fetchAllPages } from '../../lib/paginate.js';
import { resolveResource } from '../../lib/resolve.js';
import { formatTable, statusColor, formatDate } from '../../lib/output.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import { confirmDestruction } from '../../lib/interactive.js';
import type { VpsSnapshot, VpsInstance } from '../../types/api.js';

const lsCommand = new Command('ls')
  .description('List VPS snapshots (those of a deleted VPS stay listed until they expire)')
  .option('--instance <name-or-id>', 'Filter by VPS name or ID')
  .action(async (opts: { instance?: string }) => {
    const api = await ApiClient.create();
    const { items, total, truncated } = await fetchAllPages<VpsSnapshot>(api, '/api/v1/snapshots/vps');

    let rows = items;
    if (opts.instance) {
      const instance = await resolveResource<VpsInstance>(api, '/api/v1/vps', 'VPS', opts.instance);
      rows = items.filter(s => s.vps_instance_id === instance.id);
    }

    if (isJsonMode()) {
      jsonOutput(rows);
      return;
    }

    if (rows.length === 0) {
      console.log('No VPS snapshots found.');
      return;
    }

    console.log(formatTable(
      ['ID', 'NAME', 'VPS', 'STATUS', 'SIZE', 'CREATED'],
      rows.map(s => [
        s.id,
        s.name,
        s.vps_instance
          ? `${s.vps_instance.name}${s.vps_instance.deleted_at ? ' (deleted)' : ''}`
          : s.vps_instance_id,
        statusColor(s.status),
        s.size_gb != null ? `${Number(s.size_gb).toFixed(2)} GB` : '-',
        formatDate(s.created_at),
      ]),
    ));

    if (truncated) {
      console.log(chalk.dim(`Showing ${items.length} of ${total}. Refine with the web console for the full list.`));
    }
  });

const createCommand = new Command('create')
  .description('Create a snapshot of a VPS')
  .argument('<vps-name-or-id>', 'VPS name or ID')
  .option('--name <name>', 'Snapshot name')
  .option('--description <text>', 'Optional description')
  .addHelpText('after', '\nRequires: snapshot:write (API token).')
  .action(async (nameOrId: string, opts: { name?: string; description?: string }) => {
    if (!opts.name) {
      console.error(chalk.red('--name is required.'));
      process.exit(1);
    }

    const api = await ApiClient.create();
    const instance = await resolveResource<VpsInstance>(api, '/api/v1/vps', 'VPS', nameOrId);

    const body: Record<string, unknown> = {
      vps_instance_id: instance.id,
      name: opts.name,
    };
    if (opts.description) body.description = opts.description;

    const spinner = isJsonMode() ? null : ora('Creating snapshot...').start();
    const res = await api.post<{ message: string; snapshot: VpsSnapshot }>('/api/v1/snapshots/vps', body);

    if (isJsonMode()) {
      jsonOutput(res.snapshot);
      return;
    }
    spinner!.succeed(`Snapshot ${chalk.bold(res.snapshot.name)} (${res.snapshot.id}) creation initiated`);
  });

const restoreCommand = new Command('restore')
  .description('Restore a snapshot onto its source VPS (replaces the VPS disk with the snapshot)')
  .argument('<snapshot-id>', 'Snapshot ID')
  .option('-f, --force', 'Skip confirmation')
  .option('-y, --yes', 'Alias for --force')
  .addHelpText('after', '\nRequires: snapshot:write (API token) and the vps:delete permission in the project.')
  .action(async (snapshotId: string, opts: { force?: boolean; yes?: boolean }) => {
    const proceed = await confirmDestruction(
      `restore of snapshot ${snapshotId}`,
      `Restore snapshot ${snapshotId}? This replaces the disk of the VPS with the snapshot; everything written since is lost.`,
      opts.force || opts.yes,
    );
    if (!proceed) {
      console.log('Cancelled.');
      return;
    }

    const api = await ApiClient.create();
    const spinner = isJsonMode() ? null : ora('Restoring snapshot...').start();
    const res = await api.post<{ message: string; operation_id?: string }>(`/api/v1/snapshots/vps/${snapshotId}/restore`);

    if (isJsonMode()) {
      jsonOutput({ status: 'restoring', id: snapshotId, message: res.message, operation_id: res.operation_id });
      return;
    }
    spinner!.succeed(res.message || 'Restore initiated');
  });

const cloneCommand = new Command('clone')
  .description('Create a NEW VPS from a snapshot (the source VPS is untouched)')
  .argument('<snapshot-id>', 'Snapshot ID')
  .option('--name <name>', 'Name for the new VPS: 3-32 characters, lowercase letters, digits and hyphens; must start and end with a letter or digit')
  .addHelpText('after', `
The new VPS gets the plan, image and datacenter of the VPS the snapshot was
taken from, counts against the project's VPS limit and takes 10 to 30 minutes
to provision. The command returns as soon as the clone is accepted.

Requires: snapshot:write and vps:write (API token), and the vps:write permission
in the project.

Errors:
  404  not enabled for your account, or no such snapshot
  409  another clone of this snapshot is still running; wait for it to finish
  422  the snapshot is not ready or its export is not complete, the name is
       invalid or taken, the VPS limit is reached, or there is no capacity
`)
  .action(async (snapshotId: string, opts: { name?: string }) => {
    if (!opts.name) {
      console.error(chalk.red('--name is required.'));
      process.exit(1);
    }

    const api = await ApiClient.create();
    const spinner = isJsonMode() ? null : ora('Cloning snapshot...').start();
    const res = await api.post<{ message: string; instance: VpsInstance }>(
      `/api/v1/snapshots/vps/${snapshotId}/clone`,
      { name: opts.name },
    );

    if (isJsonMode()) {
      jsonOutput(res.instance);
      return;
    }
    spinner!.succeed(`Clone ${chalk.bold(res.instance.name)} (${res.instance.id}) creation initiated`);
    console.log(`Provisioning takes 10 to 30 minutes. Follow it with: danube vps get ${res.instance.name}`);
  });

const rmCommand = new Command('rm')
  .alias('delete')
  .description('Delete a VPS snapshot')
  .argument('<snapshot-id>', 'Snapshot ID')
  .option('-f, --force', 'Skip confirmation')
  .option('-y, --yes', 'Alias for --force')
  .addHelpText('after', '\nRequires: snapshot:delete (API token).')
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
    await api.delete<{ message: string }>(`/api/v1/snapshots/vps/${snapshotId}`);

    if (isJsonMode()) {
      jsonOutput({ status: 'deleting', id: snapshotId });
      return;
    }
    spinner!.succeed('Snapshot deletion initiated');
  });

export const snapshotsCommand = new Command('snapshots')
  .alias('snapshot')
  .description('Manage VPS snapshots')
  .addCommand(lsCommand)
  .addCommand(createCommand)
  .addCommand(restoreCommand)
  .addCommand(cloneCommand)
  .addCommand(rmCommand);
