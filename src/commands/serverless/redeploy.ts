import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import { resolveContainer } from './resolve.js';

export const redeployCommand = new Command('redeploy')
  .description('Redeploy a container with its current image (rolls out a new zero-downtime revision)')
  .argument('<name-or-id>', 'Container name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const container = await resolveContainer(api, nameOrId);

    const spinner = isJsonMode() ? null : ora('Redeploying...').start();
    const res = await api.post<{ message: string; container_id: string; status: string }>(
      `/api/v1/serverless/${container.id}/redeploy`,
    );

    if (isJsonMode()) {
      jsonOutput({ id: container.id, status: res.status, message: res.message });
      return;
    }
    spinner!.succeed(`${chalk.bold(container.name)}: ${res.message}`);
  });
