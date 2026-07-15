import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client.js';
import { resolveContainer } from './resolve.js';
import { confirmDestruction } from '../../lib/interactive.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import type { MessageResponse } from '../../types/api.js';

export const rmCommand = new Command('rm')
  .alias('delete')
  .description('Delete a serverless container')
  .argument('<name-or-id>', 'Container name or ID')
  .option('-f, --force', 'Skip confirmation')
  .option('-y, --yes', 'Alias for --force')
  .action(async (nameOrId: string, opts: { force?: boolean; yes?: boolean }) => {
    const api = await ApiClient.create();
    const container = await resolveContainer(api, nameOrId);

    const proceed = await confirmDestruction(
      `deletion of container ${container.name}`,
      `Delete container '${container.name}'? This cannot be undone.`,
      opts.force || opts.yes,
    );
    if (!proceed) {
      console.log('Cancelled.');
      return;
    }

    const spinner = isJsonMode() ? null : ora('Deleting container...').start();
    await api.delete<MessageResponse>(`/api/v1/serverless/${container.id}`);

    if (isJsonMode()) {
      jsonOutput({ status: 'deleted', id: container.id });
      return;
    }
    spinner!.succeed(`Deleted ${chalk.bold(container.name)}`);
  });
