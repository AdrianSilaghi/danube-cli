import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client.js';
import { resolveContainer } from './resolve.js';
import type { MessageResponse } from '../../types/api.js';

export const rmCommand = new Command('rm')
  .description('Delete a serverless container')
  .argument('<name-or-id>', 'Container name or ID')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (nameOrId: string, opts: { yes?: boolean }) => {
    const api = await ApiClient.create();
    const container = await resolveContainer(api, nameOrId);

    if (!opts.yes) {
      const confirmed = await confirm({
        message: `Delete container '${container.name}'? This cannot be undone.`,
        default: false,
      });

      if (!confirmed) {
        console.log('Cancelled.');
        return;
      }
    }

    const spinner = ora('Deleting container...').start();
    await api.delete<MessageResponse>(`/api/v1/serverless/${container.id}`);
    spinner.succeed(`Deleted ${chalk.bold(container.name)}`);
  });
