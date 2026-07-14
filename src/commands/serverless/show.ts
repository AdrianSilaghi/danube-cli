import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { statusColor, formatDate, printDetails } from '../../lib/output.js';
import { resolveContainer } from './resolve.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import type { ServerlessShowResponse } from '../../types/api.js';

export const showCommand = new Command('get')
  .alias('show')
  .description('Show serverless container details')
  .argument('<name-or-id>', 'Container name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const container = await resolveContainer(api, nameOrId);

    const res = await api.get<ServerlessShowResponse>(
      `/api/v1/serverless/${container.id}`,
    );

    if (isJsonMode()) {
      jsonOutput({ ...res.container, url: res.url, monthly_cost: res.monthly_cost });
      return;
    }

    const c = res.container;
    console.log(chalk.bold(c.name));

    const imageValue = (c.deployment_type === 'docker_image' || (c.image && c.image !== 'pending-build'))
      ? `${c.image}:${c.image_tag}`
      : chalk.dim('(awaiting first build)');

    const lines: Array<[string, string]> = [
      ['ID', c.id],
      ['Status', statusColor(c.status)],
      ['Deployment Type', c.deployment_type],
      ['Image', imageValue],
      ['Port', String(c.port)],
      ['Profile', c.resource_profile],
      ['URL', res.url || '-'],
      ['Monthly Cost', `\u20AC${res.monthly_cost.toFixed(2)}`],
      ['Created', formatDate(c.created_at)],
    ];

    printDetails(lines);

    // Scaling configuration
    console.log();
    console.log(chalk.bold('Scaling'));

    const scalingLines: Array<[string, string]> = [
      ['Min Replicas', String(c.min_scale)],
      ['Max Replicas', String(c.max_scale)],
      ['Current', String(c.current_replicas ?? 0)],
      ['Metric', c.scaling_metric ?? 'rps'],
      ['Target', String(c.scaling_target ?? 100)],
    ];
    if (c.concurrency_target) {
      scalingLines.push(['Concurrency', String(c.concurrency_target)]);
    }
    if (c.timeout_seconds) {
      scalingLines.push(['Timeout', `${c.timeout_seconds}s`]);
    }

    printDetails(scalingLines);

    // Environment variables
    const envVars = c.environment_variables ?? {};
    const envKeys = Object.keys(envVars);
    if (envKeys.length > 0) {
      console.log();
      console.log(chalk.bold('Environment Variables'));
      for (const key of envKeys) {
        console.log(`  ${key}=[hidden]`);
      }
    }
  });
