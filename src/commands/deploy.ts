import { Command } from 'commander';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import type { ApiClient } from '../lib/api-client.js';
import { readDanubeJson } from '../lib/project.js';
import { openLinkedSite } from '../lib/linked-site.js';
import { packageDirectory } from '../lib/packager.js';
import { formatBytes } from '../lib/output.js';
import { isJsonMode, jsonEnvelope, jsonOutput } from '../lib/json-mode.js';
import {
  captureDeployBaseline,
  waitForBuild,
  waitForPublish,
  waitUntilServed,
  type DeployBaseline,
  type DeployFailure,
  type DeployTimeout,
  type ServeOutcome,
} from '../lib/static-site-deploy.js';
import type { DeployResponse, StaticSite, StaticSiteBuild } from '../types/api.js';

export const deployCommand = new Command('deploy')
  .description('Deploy your site to DanubeData')
  .option('--dir <directory>', 'Directory to deploy (overrides danube.json)')
  .option('--no-wait', 'Skip waiting for deployment to complete')
  .action(async (opts: { dir?: string; wait: boolean }) => {
    const danubeJson = await readDanubeJson();

    // Resolve deploy directory
    const deployDir = resolve(opts.dir || danubeJson?.outputDir || '.');

    // Verify directory exists — before any network call, so a mistyped --dir
    // fails at once, even offline.
    try {
      await access(deployDir);
    } catch {
      console.error(chalk.red(`Directory not found: ${deployDir}`));
      process.exit(1);
    }

    const { api, site } = await openLinkedSite();

    // Package files
    const packSpinner = step('Packaging files...');
    const { buffer, fileCount } = await packageDirectory(deployDir, danubeJson?.ignore);
    packSpinner?.succeed(`Packaged ${fileCount} files (${formatBytes(buffer.length)})`);

    // Taken right BEFORE the upload: the build and revision this deploy
    // produces are the first ones newer than these.
    const baseline = await captureDeployBaseline(api, site.id);

    // Upload
    const uploadSpinner = step('Uploading...');
    const deployRes = await api.upload<DeployResponse>(
      `/api/v1/static-sites/${site.id}/deploy`,
      buffer,
      'deploy.zip',
    );
    uploadSpinner?.succeed('Uploaded');

    if (!opts.wait) {
      if (isJsonMode()) {
        jsonOutput({ status: deployRes.status, site_id: deployRes.site_id, file_count: fileCount });
        return;
      }
      console.log(chalk.green(`\nDeployment started. Status: ${deployRes.status}`));
      return;
    }

    await followDeploy(api, site, baseline, fileCount);
  });

/** A spinner for humans; nothing at all in JSON mode. */
function step(text: string): Ora | null {
  return isJsonMode() ? null : ora(text).start();
}

/**
 * Build → publish → served, each confirmed before the next is claimed.
 *
 * "Live at" used to be printed as soon as a build succeeded, which was twice
 * wrong: the build could be an earlier one, and a successful build is not a
 * published revision, let alone one the URL serves.
 */
async function followDeploy(api: ApiClient, site: StaticSite, baseline: DeployBaseline, fileCount: number): Promise<void> {
  const building = step('Waiting for the build to start...');
  const built = await waitForBuild(api, site.id, baseline, (status) => {
    if (building) building.text = `Building (${status})...`;
  });
  if (built.kind !== 'built') return stopDeploy(built, building, fileCount);
  building?.succeed(`Built (build #${built.build.build_number})`);

  const publishing = step('Publishing...');
  const published = await waitForPublish(api, site.id, baseline, true);
  if (published.kind !== 'published') return stopDeploy({ ...published, build: built.build }, publishing, fileCount);
  publishing?.succeed(`Published revision #${published.site.deployment_count}`);

  const serving = step(`Waiting for ${published.site.url} to serve it...`);
  const served = await waitUntilServed(published.site.url, built.build.id);
  reportDeployed(served, serving, {
    build: built.build,
    revision: published.site.deployment_count,
    url: published.site.url,
    fileCount,
  });
}

interface DeployedSummary {
  build: StaticSiteBuild;
  revision: number;
  url: string;
  fileCount: number;
}

function reportDeployed(served: ServeOutcome, spinner: Ora | null, summary: DeployedSummary): void {
  if (isJsonMode()) {
    jsonOutput({
      status: 'succeeded',
      build_number: summary.build.build_number,
      revision: summary.revision,
      url: summary.url,
      live: served !== 'not_confirmed',
      file_count: summary.fileCount,
    });
    return;
  }

  if (served === 'not_confirmed') {
    spinner!.warn('Published, but the new version was not being served yet');
    console.log(`\nIt should be live within a minute at: ${chalk.bold(summary.url)}`);
    return;
  }

  spinner!.succeed(served === 'live' ? 'Serving the new version' : 'Deployed (password-protected, so not checked from outside)');
  console.log(chalk.green(`\nLive at: ${chalk.bold(summary.url)}`));
}

const FAILURE_TITLES: Record<DeployFailure['code'], string> = {
  build_failed: 'Build failed',
  deploy_failed: 'Deployment failed',
  held_for_review: 'Deployment held for review',
  suspended: 'Site suspended',
};

/**
 * A failure exits 1 in both modes. A timeout keeps its long-standing contract:
 * a warning and exit 0 for a person (the platform allows builds longer than
 * the CLI waits), exit 1 with `status: timeout` under --json.
 */
function stopDeploy(outcome: DeployFailure | DeployTimeout, spinner: Ora | null, fileCount: number): void {
  const buildNumber = outcome.build?.build_number ?? null;

  if (outcome.kind === 'failed') {
    if (isJsonMode()) {
      jsonEnvelope(
        { status: 'failed', build_number: buildNumber, file_count: fileCount },
        { error: { code: `static_site.${outcome.code}`, message: outcome.message } },
      );
    } else {
      spinner!.fail(FAILURE_TITLES[outcome.code]);
      console.error(chalk.red(outcome.message));
    }
    process.exit(1);
  }

  const message = `Timed out waiting for the ${outcome.phase}. Check status with \`danube pages deployments ls\`.`;
  if (isJsonMode()) {
    jsonEnvelope(
      { status: 'timeout', phase: outcome.phase, build_number: buildNumber, file_count: fileCount },
      { error: { code: 'static_site.timeout', message, retryable: true } },
    );
    process.exit(1);
  }
  spinner!.warn(message);
}
