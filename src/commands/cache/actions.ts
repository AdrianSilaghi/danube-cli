import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { confirm } from '@inquirer/prompts';
import { ApiClient } from '../../lib/api-client.js';
import { resolveResource } from '../../lib/resolve.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import { formatBytes } from '../../lib/output.js';
import type { CacheConnectionInfo, CacheMetricsResponse, CacheInstance } from '../../types/api.js';

export const startCommand = new Command('start')
  .description('Start a stopped cache instance')
  .argument('<name-or-id>', 'Cache instance name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const instance = await resolveResource<CacheInstance>(api, '/api/v1/cache', 'cache', nameOrId);
    const spinner = isJsonMode() ? null : ora('Starting cache...').start();
    const res = await api.post<{ message: string; status: string }>(`/api/v1/cache/${instance.id}/start`);

    if (isJsonMode()) {
      jsonOutput({ status: res.status, message: res.message, id: instance.id });
      return;
    }
    spinner!.succeed(res.message);
  });

export const stopCommand = new Command('stop')
  .description('Stop a running cache instance')
  .argument('<name-or-id>', 'Cache instance name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const instance = await resolveResource<CacheInstance>(api, '/api/v1/cache', 'cache', nameOrId);
    const spinner = isJsonMode() ? null : ora('Stopping cache...').start();
    const res = await api.post<{ message: string; status: string }>(`/api/v1/cache/${instance.id}/stop`);

    if (isJsonMode()) {
      jsonOutput({ status: res.status, message: res.message, id: instance.id });
      return;
    }
    spinner!.succeed(res.message);
  });

export const connectionInfoCommand = new Command('connection-info')
  .description('Show connection URL and password for a cache instance')
  .argument('<name-or-id>', 'Cache instance name or ID')
  .action(async (nameOrId: string) => {
    if (!isJsonMode()) {
      const confirmed = await confirm({
        message: 'This will display the cache password in your terminal. Continue?',
        default: false,
      });
      if (!confirmed) {
        console.log('Cancelled.');
        return;
      }
    }

    const api = await ApiClient.create();
    const instance = await resolveResource<CacheInstance>(api, '/api/v1/cache', 'cache', nameOrId);
    const res = await api.get<CacheConnectionInfo>(`/api/v1/cache/${instance.id}/connection-info`);

    if (isJsonMode()) {
      jsonOutput(res);
      return;
    }

    console.log('');
    console.log(`  Connection: ${chalk.bold(res.connection_info)}`);
    console.log(`  Password:   ${chalk.bold.yellow(res.password)}`);
    console.log('');
  });

export const metricsCommand = new Command('metrics')
  .description('Show cache instance metrics summary')
  .argument('<name-or-id>', 'Cache instance name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const instance = await resolveResource<CacheInstance>(api, '/api/v1/cache', 'cache', nameOrId);
    const res = await api.get<CacheMetricsResponse>(`/api/v1/cache/${instance.id}/metrics`);

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
      ['Commands Processed', s.total_commands_processed.toLocaleString('en-US')],
      ['Keyspace Hits', s.keyspace_hits.toLocaleString('en-US')],
      ['Keyspace Misses', s.keyspace_misses.toLocaleString('en-US')],
      ['Hit Ratio', `${s.hit_ratio_percentage}%`],
      ['Retrieved', s.retrieved_at],
    ];

    const maxLabel = Math.max(...lines.map(([l]) => l!.length));
    for (const [label, value] of lines) {
      console.log(`${chalk.dim(label!.padEnd(maxLabel))}  ${value}`);
    }
  });

export const dnsCommand = new Command('dns')
  .description('Enable or disable public DNS for a cache instance');

dnsCommand
  .command('enable')
  .description('Enable public DNS')
  .argument('<name-or-id>', 'Cache instance name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const instance = await resolveResource<CacheInstance>(api, '/api/v1/cache', 'cache', nameOrId);
    const spinner = isJsonMode() ? null : ora('Enabling DNS...').start();
    const res = await api.post<{ message: string }>(`/api/v1/cache/${instance.id}/dns`);

    if (isJsonMode()) {
      jsonOutput({ id: instance.id, enabled: true, message: res.message });
      return;
    }
    spinner!.succeed(res.message || 'DNS enabled');
  });

dnsCommand
  .command('disable')
  .description('Disable public DNS')
  .argument('<name-or-id>', 'Cache instance name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const instance = await resolveResource<CacheInstance>(api, '/api/v1/cache', 'cache', nameOrId);
    const spinner = isJsonMode() ? null : ora('Disabling DNS...').start();
    const res = await api.delete<{ message: string }>(`/api/v1/cache/${instance.id}/dns`);

    if (isJsonMode()) {
      jsonOutput({ id: instance.id, enabled: false, message: res.message });
      return;
    }
    spinner!.succeed(res.message || 'DNS disabled');
  });
