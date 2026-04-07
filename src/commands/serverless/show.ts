import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { statusColor, formatDate } from '../../lib/output.js';
import { resolveContainer } from './resolve.js';
import type { ServerlessShowResponse } from '../../types/api.js';

export const showCommand = new Command('show')
  .description('Show serverless container details')
  .argument('<name-or-id>', 'Container name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const container = await resolveContainer(api, nameOrId);

    const res = await api.get<ServerlessShowResponse>(
      `/api/v1/serverless/${container.id}`,
    );

    const c = res.container;
    console.log(chalk.bold(c.name));
    console.log(`  ID:              ${c.id}`);
    console.log(`  Status:          ${statusColor(c.status)}`);
    console.log(`  Deployment Type: ${c.deployment_type}`);
    if (c.deployment_type === 'docker_image' || (c.image && c.image !== 'pending-build')) {
      console.log(`  Image:           ${c.image}:${c.image_tag}`);
    } else {
      console.log(`  Image:           ${chalk.dim('(awaiting first build)')}`);
    }
    console.log(`  Port:            ${c.port}`);
    console.log(`  Profile:         ${c.resource_profile}`);
    console.log(`  URL:             ${res.url || '-'}`);
    console.log(`  Monthly Cost:    \u20AC${res.monthly_cost.toFixed(2)}`);
    console.log(`  Created:         ${formatDate(c.created_at)}`);

    // Scaling configuration
    console.log();
    console.log(chalk.bold('Scaling'));
    console.log(`  Min Replicas:    ${c.min_scale}`);
    console.log(`  Max Replicas:    ${c.max_scale}`);
    console.log(`  Current:         ${c.current_replicas ?? 0}`);
    console.log(`  Metric:          ${c.scaling_metric ?? 'rps'}`);
    console.log(`  Target:          ${c.scaling_target ?? 100}`);
    if (c.concurrency_target) {
      console.log(`  Concurrency:     ${c.concurrency_target}`);
    }
    if (c.timeout_seconds) {
      console.log(`  Timeout:         ${c.timeout_seconds}s`);
    }

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
