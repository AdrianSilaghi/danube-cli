import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client.js';
import { resolveResource } from '../../lib/resolve.js';
import { formatTable, statusColor } from '../../lib/output.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import { confirmDestruction } from '../../lib/interactive.js';
import type { DatabaseInstance, DatabaseReplicaList, DatabaseReplicationStatus } from '../../types/api.js';

const lsCommand = new Command('ls')
  .description('List replicas for a database instance')
  .argument('<name-or-id>', 'Database instance name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const instance = await resolveResource<DatabaseInstance>(api, '/api/v1/database', 'database', nameOrId);
    const res = await api.get<DatabaseReplicaList>(`/api/v1/database/${instance.id}/replicas`);

    if (isJsonMode()) {
      jsonOutput(res);
      return;
    }

    console.log(chalk.bold('Master'));
    console.log(`  ${res.master.name}  ${statusColor(res.master.status)}  ${res.master.endpoint ?? '-'}`);
    console.log('');

    if (res.replicas.length === 0) {
      console.log('No replicas configured.');
      return;
    }

    console.log(chalk.bold('Replicas'));
    console.log(formatTable(
      ['#', 'NAME', 'STATUS', 'READY', 'ENDPOINT', 'LAG (s)', 'HEALTHY'],
      res.replicas.map(r => [
        String(r.replica_index),
        r.name,
        statusColor(r.status),
        r.ready ? chalk.green('yes') : chalk.red('no'),
        r.endpoint ?? '-',
        r.seconds_behind_master != null ? String(r.seconds_behind_master) : '-',
        r.is_replication_healthy ? chalk.green('yes') : chalk.red('no'),
      ]),
    ));
  });

const addCommand = new Command('add')
  .description('Add one or more replicas to a database instance')
  .argument('<name-or-id>', 'Database instance name or ID')
  .option('--count <n>', 'Number of replicas to add', '1')
  .action(async (nameOrId: string, opts: { count: string }) => {
    const count = parseInt(opts.count, 10);
    if (!Number.isFinite(count) || count < 1) {
      console.error(chalk.red('--count must be a positive integer.'));
      process.exit(1);
    }

    const api = await ApiClient.create();
    const instance = await resolveResource<DatabaseInstance>(api, '/api/v1/database', 'database', nameOrId);
    const spinner = isJsonMode() ? null : ora(`Adding ${count} replica${count > 1 ? 's' : ''}...`).start();
    const res = await api.post<{ message: string; replicas: Array<Record<string, unknown>> }>(
      `/api/v1/database/${instance.id}/replicas`,
      { replica_count: count },
    );

    if (isJsonMode()) {
      jsonOutput(res);
      return;
    }
    spinner!.succeed(res.message);
  });

const rmCommand = new Command('rm')
  .alias('delete')
  .description('Remove a replica by index')
  .argument('<name-or-id>', 'Database instance name or ID')
  .argument('<index>', 'Replica index (1-based)')
  .option('-f, --force', 'Skip confirmation')
  .option('-y, --yes', 'Alias for --force')
  .action(async (nameOrId: string, index: string, opts: { force?: boolean; yes?: boolean }) => {
    const api = await ApiClient.create();
    const instance = await resolveResource<DatabaseInstance>(api, '/api/v1/database', 'database', nameOrId);

    const proceed = await confirmDestruction(
      `removal of replica #${index} from database ${instance.name}`,
      `Remove replica #${index} from database ${instance.name} (${instance.id})?`,
      opts.force || opts.yes,
    );
    if (!proceed) {
      console.log('Cancelled.');
      return;
    }

    const spinner = isJsonMode() ? null : ora('Removing replica...').start();
    const res = await api.delete<{ message: string; status: string }>(
      `/api/v1/database/${instance.id}/replicas/${index}`,
    );

    if (isJsonMode()) {
      jsonOutput({ instance_id: instance.id, index: Number(index), status: res.status });
      return;
    }
    spinner!.succeed(res.message);
  });

const statusCommand = new Command('status')
  .description('Show replication status (lag per replica)')
  .argument('<name-or-id>', 'Database instance name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const instance = await resolveResource<DatabaseInstance>(api, '/api/v1/database', 'database', nameOrId);
    const res = await api.get<DatabaseReplicationStatus>(`/api/v1/database/${instance.id}/replicas/status`);

    if (isJsonMode()) {
      jsonOutput(res);
      return;
    }

    const lines = [
      ['Replicating', res.is_replicating ? chalk.green('yes') : chalk.red('no')],
      ['Replica Count', String(res.replica_count)],
    ];
    const maxLabel = Math.max(...lines.map(([l]) => l!.length));
    for (const [label, value] of lines) {
      console.log(`${chalk.dim(label!.padEnd(maxLabel))}  ${value}`);
    }

    if (res.replicas.length === 0) {
      return;
    }

    console.log('');
    console.log(formatTable(
      ['#', 'NAME', 'STATUS', 'READY', 'REPL STATUS', 'LAG (s)', 'HEALTHY'],
      res.replicas.map(r => [
        String(r.replica_index),
        r.name,
        statusColor(r.status),
        r.ready ? chalk.green('yes') : chalk.red('no'),
        r.replication_status ?? '-',
        r.seconds_behind_master != null ? String(r.seconds_behind_master) : '-',
        r.is_replication_healthy ? chalk.green('yes') : chalk.red('no'),
      ]),
    ));
  });

export const replicasCommand = new Command('replicas')
  .description('Manage database read replicas')
  .addCommand(lsCommand)
  .addCommand(addCommand)
  .addCommand(rmCommand)
  .addCommand(statusCommand);
