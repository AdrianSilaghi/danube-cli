import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { resolveContainer } from './resolve.js';
import type { ServerlessUsageResponse } from '../../types/api.js';

export const usageCommand = new Command('usage')
  .description('Show usage and billing for a serverless container')
  .argument('<name-or-id>', 'Container name or ID')
  .option('--period <period>', 'Billing period (YYYY-MM)')
  .action(async (nameOrId: string, opts: { period?: string }) => {
    const api = await ApiClient.create();
    const container = await resolveContainer(api, nameOrId);

    if (opts.period && !/^\d{4}-\d{2}$/.test(opts.period)) {
      console.error(chalk.red('Invalid period format. Use YYYY-MM (e.g. 2025-03).'));
      process.exit(1);
    }

    const query = opts.period ? `?period=${encodeURIComponent(opts.period)}` : '';
    const res = await api.get<ServerlessUsageResponse>(
      `/api/v1/serverless/${container.id}/usage${query}`,
    );

    console.log(chalk.bold(`Usage for ${container.name}`));
    console.log(`  Period:           ${res.period}`);
    console.log(`  Total Requests:   ${res.summary.total_requests.toLocaleString()}`);
    console.log(`  Compute Seconds:  ${res.summary.total_compute_seconds.toFixed(2)}`);
    console.log(`  Cost:             \u20AC${res.summary.total_cost_dollars.toFixed(2)}`);
  });
