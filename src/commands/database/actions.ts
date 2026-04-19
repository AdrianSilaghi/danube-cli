import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { confirm } from '@inquirer/prompts';
import { ApiClient } from '../../lib/api-client.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import type { DatabaseCredentials } from '../../types/api.js';

export const startCommand = new Command('start')
  .description('Start a stopped database instance')
  .argument('<id>', 'Database instance ID')
  .action(async (id: string) => {
    const api = await ApiClient.create();
    const spinner = isJsonMode() ? null : ora('Starting database...').start();
    const res = await api.post<{ message: string; status: string }>(`/api/v1/database/${id}/start`);

    if (isJsonMode()) {
      jsonOutput({ status: res.status, message: res.message, id });
      return;
    }
    spinner!.succeed(res.message);
  });

export const stopCommand = new Command('stop')
  .description('Stop a running database instance')
  .argument('<id>', 'Database instance ID')
  .action(async (id: string) => {
    const api = await ApiClient.create();
    const spinner = isJsonMode() ? null : ora('Stopping database...').start();
    const res = await api.post<{ message: string; status: string }>(`/api/v1/database/${id}/stop`);

    if (isJsonMode()) {
      jsonOutput({ status: res.status, message: res.message, id });
      return;
    }
    spinner!.succeed(res.message);
  });

export const credentialsCommand = new Command('credentials')
  .description('Show connection URL, username, and password for a database')
  .argument('<id>', 'Database instance ID')
  .action(async (id: string) => {
    if (!isJsonMode()) {
      const confirmed = await confirm({
        message: 'This will display the database password in your terminal. Continue?',
        default: false,
      });
      if (!confirmed) {
        console.log('Cancelled.');
        return;
      }
    }

    const api = await ApiClient.create();
    const res = await api.get<DatabaseCredentials>(`/api/v1/database/${id}/credentials`);

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

export const dnsCommand = new Command('dns')
  .description('Enable or disable public DNS for a database instance');

dnsCommand
  .command('enable')
  .description('Enable public DNS')
  .argument('<id>', 'Database instance ID')
  .action(async (id: string) => {
    const api = await ApiClient.create();
    const spinner = isJsonMode() ? null : ora('Enabling DNS...').start();
    const res = await api.post<{ message: string }>(`/api/v1/database/${id}/dns`);

    if (isJsonMode()) {
      jsonOutput({ id, enabled: true, message: res.message });
      return;
    }
    spinner!.succeed(res.message || 'DNS enabled');
  });

dnsCommand
  .command('disable')
  .description('Disable public DNS')
  .argument('<id>', 'Database instance ID')
  .action(async (id: string) => {
    const api = await ApiClient.create();
    const spinner = isJsonMode() ? null : ora('Disabling DNS...').start();
    const res = await api.delete<{ message: string }>(`/api/v1/database/${id}/dns`);

    if (isJsonMode()) {
      jsonOutput({ id, enabled: false, message: res.message });
      return;
    }
    spinner!.succeed(res.message || 'DNS disabled');
  });
