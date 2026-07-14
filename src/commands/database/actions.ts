import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client.js';
import { resolveResource } from '../../lib/resolve.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import { formatBytes } from '../../lib/output.js';
import { confirmDestruction } from '../../lib/interactive.js';
import type { DatabaseCredentials, DatabaseMetricsResponse, DatabaseInstance } from '../../types/api.js';

export const startCommand = new Command('start')
  .description('Start a stopped database instance')
  .argument('<name-or-id>', 'Database instance name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const instance = await resolveResource<DatabaseInstance>(api, '/api/v1/database', 'database', nameOrId);
    const spinner = isJsonMode() ? null : ora('Starting database...').start();
    const res = await api.post<{ message: string; status: string }>(`/api/v1/database/${instance.id}/start`);

    if (isJsonMode()) {
      jsonOutput({ status: res.status, message: res.message, id: instance.id });
      return;
    }
    spinner!.succeed(res.message);
  });

export const stopCommand = new Command('stop')
  .description('Stop a running database instance')
  .argument('<name-or-id>', 'Database instance name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const instance = await resolveResource<DatabaseInstance>(api, '/api/v1/database', 'database', nameOrId);
    const spinner = isJsonMode() ? null : ora('Stopping database...').start();
    const res = await api.post<{ message: string; status: string }>(`/api/v1/database/${instance.id}/stop`);

    if (isJsonMode()) {
      jsonOutput({ status: res.status, message: res.message, id: instance.id });
      return;
    }
    spinner!.succeed(res.message);
  });

export const credentialsCommand = new Command('credentials')
  .description('Show connection URL, username, and password for a database')
  .argument('<name-or-id>', 'Database instance name or ID')
  .option('-f, --force', 'Skip confirmation')
  .option('-y, --yes', 'Alias for --force')
  .action(async (nameOrId: string, opts: { force?: boolean; yes?: boolean }) => {
    const api = await ApiClient.create();
    const instance = await resolveResource<DatabaseInstance>(api, '/api/v1/database', 'database', nameOrId);

    const proceed = await confirmDestruction(
      `credentials reveal for ${instance.name}`,
      'This will display the database password in your terminal. Continue?',
      opts.force || opts.yes,
    );
    if (!proceed) {
      console.log('Cancelled.');
      return;
    }

    const res = await api.get<DatabaseCredentials>(`/api/v1/database/${instance.id}/credentials`);

    if (isJsonMode()) {
      jsonOutput(res);
      return;
    }

    console.log('');
    console.log(`  Connection: ${chalk.bold(res.connection_info)}`);
    console.log(`  Username:   ${chalk.bold(res.username)}`);
    console.log(`  Password:   ${chalk.bold.yellow(res.password)}`);
    console.log('');
  });

export const metricsCommand = new Command('metrics')
  .description('Show database instance metrics summary')
  .argument('<name-or-id>', 'Database instance name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const instance = await resolveResource<DatabaseInstance>(api, '/api/v1/database', 'database', nameOrId);
    const res = await api.get<DatabaseMetricsResponse>(`/api/v1/database/${instance.id}/metrics`);

    if (isJsonMode()) {
      jsonOutput(res);
      return;
    }

    const s = res.summary;
    const h = res.health;

    const lines = [
      ['Health', h.is_healthy ? chalk.green('healthy') : chalk.red('unhealthy')],
      ['Memory Used', `${formatBytes(s.memory_used_bytes)} (${s.memory_used_mb} MB)`],
      ['Connected Clients', String(s.connected_clients)],
      ['Total Queries', s.total_queries.toLocaleString('en-US')],
      ['Slow Queries', s.slow_queries.toLocaleString('en-US')],
      ['Retrieved', s.retrieved_at],
    ];

    const maxLabel = Math.max(...lines.map(([l]) => l!.length));
    for (const [label, value] of lines) {
      console.log(`${chalk.dim(label!.padEnd(maxLabel))}  ${value}`);
    }
  });

export const dnsCommand = new Command('dns')
  .description('Enable or disable public DNS for a database instance');

dnsCommand
  .command('enable')
  .description('Enable public DNS')
  .argument('<name-or-id>', 'Database instance name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const instance = await resolveResource<DatabaseInstance>(api, '/api/v1/database', 'database', nameOrId);
    const spinner = isJsonMode() ? null : ora('Enabling DNS...').start();
    const res = await api.post<{ message: string }>(`/api/v1/database/${instance.id}/dns`);

    if (isJsonMode()) {
      jsonOutput({ id: instance.id, enabled: true, message: res.message });
      return;
    }
    spinner!.succeed(res.message || 'DNS enabled');
  });

dnsCommand
  .command('disable')
  .description('Disable public DNS')
  .argument('<name-or-id>', 'Database instance name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const instance = await resolveResource<DatabaseInstance>(api, '/api/v1/database', 'database', nameOrId);
    const spinner = isJsonMode() ? null : ora('Disabling DNS...').start();
    const res = await api.delete<{ message: string }>(`/api/v1/database/${instance.id}/dns`);

    if (isJsonMode()) {
      jsonOutput({ id: instance.id, enabled: false, message: res.message });
      return;
    }
    spinner!.succeed(res.message || 'DNS disabled');
  });
