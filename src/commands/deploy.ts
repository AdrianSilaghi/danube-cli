import { Command } from 'commander';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../lib/api-client.js';
import { readProjectConfig, readDanubeJson } from '../lib/project.js';
import { NotLinkedError } from '../lib/errors.js';
import { packageDirectory } from '../lib/packager.js';
import { formatBytes, statusColor } from '../lib/output.js';
import { sleep } from '../lib/sleep.js';
import type { DeployResponse, StaticSiteBuild } from '../types/api.js';

export const POLL_INTERVAL = 2000;
export const POLL_TIMEOUT = 5 * 60 * 1000;

export const deployCommand = new Command('deploy')
  .description('Deploy your site to DanubeData')
  .option('--dir <directory>', 'Directory to deploy (overrides danube.json)')
  .option('--no-wait', 'Skip waiting for deployment to complete')
  .action(async (opts: { dir?: string; wait: boolean }) => {
    const project = await readProjectConfig();
    if (!project) throw new NotLinkedError();

    const api = await ApiClient.create();
    const danubeJson = await readDanubeJson();

    // Resolve deploy directory
    const deployDir = resolve(opts.dir || danubeJson?.outputDir || '.');

    // Verify directory exists
    try {
      await access(deployDir);
    } catch {
      console.error(chalk.red(`Directory not found: ${deployDir}`));
      process.exit(1);
    }

    // Package files
    const packSpinner = ora('Packaging files...').start();
    const { buffer, fileCount } = await packageDirectory(deployDir, danubeJson?.ignore);
    packSpinner.succeed(`Packaged ${fileCount} files (${formatBytes(buffer.length)})`);

    // Upload
    const uploadSpinner = ora('Uploading...').start();
    const deployRes = await api.upload<DeployResponse>(
      `/api/v1/static-sites/${project.siteId}/deploy`,
      buffer,
      'deploy.tar.gz',
    );
    uploadSpinner.succeed('Uploaded');

    if (!opts.wait) {
      console.log(chalk.green(`\nDeployment started. Status: ${deployRes.status}`));
      return;
    }

    // Poll build status
    const pollSpinner = ora('Building...').start();
    const startTime = Date.now();

    while (Date.now() - startTime < POLL_TIMEOUT) {
      await sleep(POLL_INTERVAL);

      const buildRes = await api.get<{ data: StaticSiteBuild | null }>(
        `/api/v1/static-sites/${project.siteId}/builds/latest`,
      );

      const build = buildRes.data;
      if (!build) continue;

      pollSpinner.text = `Status: ${build.status}...`;

      if (build.status === 'live') {
        pollSpinner.succeed(`Deployed! Status: ${statusColor('live')}`);
        console.log(chalk.green(`\nLive at: ${chalk.bold(`https://${project.siteName}.danubesites.ro`)}`));
        return;
      }

      if (build.status === 'failed') {
        pollSpinner.fail(`Deployment failed`);
        if (build.error_message) {
          console.error(chalk.red(build.error_message));
        }
        process.exit(1);
      }
    }

    pollSpinner.warn('Timed out waiting for deployment. Check status with `danube deployments ls`.');
  });
