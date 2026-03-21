import { Command } from 'commander';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client.js';
import { packageDirectory } from '../../lib/packager.js';
import { formatBytes, statusColor } from '../../lib/output.js';
import { sleep } from '../../lib/sleep.js';
import { resolveContainer } from './resolve.js';
import type { ServerlessBuild, ServerlessDeployResponse } from '../../types/api.js';

export const POLL_INTERVAL = 2000;
export const POLL_TIMEOUT = 10 * 60 * 1000; // 10 minutes for serverless builds

export const deployCommand = new Command('deploy')
  .description('Deploy a serverless container from local directory')
  .argument('<name-or-id>', 'Container name or ID')
  .option('--dir <directory>', 'Directory to deploy (default: current directory)')
  .option('--no-wait', 'Skip waiting for build to complete')
  .action(async (nameOrId: string, opts: { dir?: string; wait: boolean }) => {
    const api = await ApiClient.create();

    // Resolve container
    const container = await resolveContainer(api, nameOrId);

    // Resolve deploy directory
    const deployDir = resolve(opts.dir || '.');

    // Verify directory exists
    try {
      await access(deployDir);
    } catch {
      console.error(chalk.red(`Directory not found: ${deployDir}`));
      process.exit(1);
    }

    // Package files
    const packSpinner = ora('Packaging files...').start();
    const { buffer, fileCount } = await packageDirectory(deployDir);
    packSpinner.succeed(`Packaged ${fileCount} files (${formatBytes(buffer.length)})`);

    // Upload
    const uploadSpinner = ora('Uploading...').start();
    await api.upload<ServerlessDeployResponse>(
      `/api/v1/serverless/${container.id}/deploy`,
      buffer,
      'deploy.zip',
    );
    uploadSpinner.succeed('Uploaded');

    if (!opts.wait) {
      console.log(chalk.green('\nBuild started. Check status with: danube serverless show ' + container.name));
      return;
    }

    // Poll build status
    const pollSpinner = ora('Building...').start();
    const startTime = Date.now();
    const abortController = new AbortController();

    let currentBuildId: string | null = null;

    const sigintHandler = async () => {
      abortController.abort();
      pollSpinner.stop();
      console.log(chalk.yellow('\nCancelling build...'));

      if (currentBuildId) {
        try {
          await api.post(`/api/v1/serverless/${container.id}/builds/${currentBuildId}/cancel`);
          console.log(chalk.yellow('Build cancelled.'));
        } catch {
          console.log(chalk.yellow('Could not cancel build on server.'));
        }
      }

      process.exit(130);
    };

    process.on('SIGINT', sigintHandler);

    try {
      while (Date.now() - startTime < POLL_TIMEOUT) {
        await sleep(POLL_INTERVAL, abortController.signal);

        const buildRes = await api.get<{ data: ServerlessBuild | null }>(
          `/api/v1/serverless/${container.id}/builds/latest`,
        );

        const build = buildRes.data;
        if (!build) continue;

        currentBuildId = build.id;
        pollSpinner.text = `Status: ${build.status}...`;

        if (build.status === 'succeeded') {
          pollSpinner.succeed(`Build #${build.build_number} ${statusColor('succeeded')}`);
          if (container.url) {
            console.log(chalk.green(`\nLive at: ${chalk.bold(container.url)}`));
          }
          return;
        }

        if (build.status === 'failed' || build.status === 'cancelled') {
          pollSpinner.fail('Build failed');
          if (build.error_message) {
            console.error(chalk.red(build.error_message));
          }
          process.exit(1);
        }
      }

      pollSpinner.warn('Timed out waiting for build. Check status with: danube serverless show ' + container.name);
    } finally {
      process.removeListener('SIGINT', sigintHandler);
    }
  });
