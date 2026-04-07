import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client.js';
import { resolveContainer } from './resolve.js';
import type { ServerlessContainer } from '../../types/api.js';

export const updateCommand = new Command('update')
  .description('Update a serverless container')
  .argument('<name-or-id>', 'Container name or ID')
  .option('--image <image>', 'Docker image')
  .option('--tag <tag>', 'Image tag')
  .option('--profile <profile>', 'Resource profile')
  .option('--port <port>', 'Container port')
  .option('--min-scale <n>', 'Minimum replicas (0 for scale-to-zero)')
  .option('--max-scale <n>', 'Maximum replicas')
  .option('--scaling-metric <metric>', 'Scaling metric (rps or concurrency)')
  .option('--scaling-target <n>', 'Target value per pod for scaling metric')
  .option('--concurrency-target <n>', 'Concurrency target per pod')
  .option('--timeout <seconds>', 'Request timeout in seconds (max 900)')
  .option('--env <pairs...>', 'Set environment variables (KEY=VALUE), merged with existing')
  .option('--rm-env <keys...>', 'Remove environment variables by key')
  .action(async (nameOrId: string, opts) => {
    const api = await ApiClient.create();
    const container = await resolveContainer(api, nameOrId);

    const parseIntOption = (val: string, name: string): number => {
      const n = parseInt(val, 10);
      if (isNaN(n)) {
        console.error(chalk.red(`Invalid value for ${name}: '${val}' is not an integer.`));
        process.exit(1);
      }
      return n;
    };

    const body: Record<string, unknown> = {};
    if (opts.image) body.image = opts.image;
    if (opts.tag) body.image_tag = opts.tag;
    if (opts.profile) body.resource_profile = opts.profile;
    if (opts.port) body.port = parseIntOption(opts.port, '--port');
    if (opts.minScale !== undefined) body.min_scale = parseIntOption(opts.minScale, '--min-scale');
    if (opts.maxScale !== undefined) body.max_scale = parseIntOption(opts.maxScale, '--max-scale');
    if (opts.scalingMetric) body.scaling_metric = opts.scalingMetric;
    if (opts.scalingTarget !== undefined) body.scaling_target = parseIntOption(opts.scalingTarget, '--scaling-target');
    if (opts.concurrencyTarget !== undefined) body.concurrency_target = parseIntOption(opts.concurrencyTarget, '--concurrency-target');
    if (opts.timeout !== undefined) body.timeout_seconds = parseIntOption(opts.timeout, '--timeout');

    // Handle environment variable changes (merge with existing)
    if (opts.env || opts.rmEnv) {
      const existingEnv: Record<string, string> = { ...(container.environment_variables ?? {}) };

      // Remove specified keys first
      if (opts.rmEnv) {
        for (const key of opts.rmEnv) {
          delete existingEnv[key];
        }
      }

      // Merge new env vars on top
      if (opts.env) {
        for (const pair of opts.env) {
          const eqIndex = pair.indexOf('=');
          if (eqIndex <= 0) {
            console.error(chalk.red(`Invalid env format: '${pair}'. Use KEY=VALUE.`));
            process.exit(1);
          }
          existingEnv[pair.substring(0, eqIndex)] = pair.substring(eqIndex + 1);
        }
      }

      body.environment_variables = existingEnv;
    }

    if (Object.keys(body).length === 0) {
      console.error(chalk.red('No update options specified. Use --help for available options.'));
      process.exit(1);
    }

    const spinner = ora('Updating container...').start();
    const res = await api.put<{ message: string; container: ServerlessContainer }>(
      `/api/v1/serverless/${container.id}`,
      body,
    );
    spinner.succeed(`Updated ${chalk.bold(res.container.name)}`);
  });
