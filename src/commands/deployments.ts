import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { fetchAllPages } from '../lib/paginate.js';
import { openLinkedSite } from '../lib/linked-site.js';
import { formatTable, statusColor, formatDate } from '../lib/output.js';
import { isJsonMode, jsonEnvelope, jsonOutput } from '../lib/json-mode.js';
import { captureSiteBaseline, waitForPublish } from '../lib/static-site-deploy.js';
import type { StaticSiteDeployment, MessageResponse } from '../types/api.js';

const lsCommand = new Command('ls')
  .description('List deployments')
  .action(async () => {
    const { api, site } = await openLinkedSite();
    const { items, total, truncated } = await fetchAllPages<StaticSiteDeployment>(
      api,
      `/api/v1/static-sites/${site.id}/deployments`,
    );

    if (isJsonMode()) {
      jsonOutput(items);
      return;
    }

    if (items.length === 0) {
      console.log('No deployments yet.');
      return;
    }

    const rows = items.map(d => [
      `#${d.revision_number}`,
      statusColor(d.status) + (d.is_current ? chalk.cyan(' (current)') : ''),
      d.trigger_type,
      d.deployed_at ? formatDate(d.deployed_at) : '-',
      formatDate(d.created_at),
    ]);

    console.log(formatTable(['REVISION', 'STATUS', 'TRIGGER', 'DEPLOYED', 'CREATED'], rows));

    if (truncated) {
      console.log(chalk.dim(`Showing ${items.length} of ${total}. Refine with the web console for the full list.`));
    }
  });

const rollbackCommand = new Command('rollback')
  .description('Activate a previous deployment')
  .argument('<revision>', 'Deployment revision number')
  .option('--no-wait', 'Return once the rollback is accepted, without waiting for it to be published')
  .action(async (revision: string, opts: { wait: boolean }) => {
    const { api, site } = await openLinkedSite();

    // Find deployment by revision (walks every page — no truncation)
    const { items } = await fetchAllPages<StaticSiteDeployment>(
      api,
      `/api/v1/static-sites/${site.id}/deployments`,
    );

    const deployment = items.find(d => d.revision_number === Number(revision));
    if (!deployment) {
      console.error(chalk.red(`Deployment revision ${revision} not found.`));
      process.exit(1);
    }

    const result = { status: 'activated', revision: Number(revision), deployment_id: deployment.id };
    const spinner = isJsonMode() ? null : ora(`Rolling back to revision ${revision}...`).start();
    const baseline = opts.wait ? await captureSiteBaseline(api, site.id) : null;
    await api.post<MessageResponse>(
      `/api/v1/static-sites/${site.id}/deployments/${deployment.id}/activate`,
    );

    if (!baseline) {
      if (isJsonMode()) {
        jsonOutput(result);
        return;
      }
      spinner!.succeed(`Rollback to revision ${revision} started`);
      return;
    }

    // The activate call only queues the rollback. It is done when the
    // platform records the revision that re-publishes the old image.
    const published = await waitForPublish(api, site.id, baseline, false);

    if (published.kind === 'published') {
      if (isJsonMode()) {
        jsonOutput({ ...result, published_revision: published.site.deployment_count, url: published.site.url });
        return;
      }
      spinner!.succeed(`Rolled back to revision ${revision} (published as revision #${published.site.deployment_count})`);
      return;
    }

    // Same contract as `pages deploy`: a timeout warns and exits 0 for a
    // person — the rollback is still in flight — and exits 1 under --json.
    if (published.kind === 'timeout') {
      const message = 'Timed out waiting for the rollback to be published. Check status with `danube pages deployments ls`.';
      if (isJsonMode()) {
        jsonEnvelope({ ...result, status: 'timeout' }, { error: { code: 'static_site.timeout', message, retryable: true } });
        process.exit(1);
      }
      spinner!.warn(message);
      return;
    }

    if (isJsonMode()) {
      jsonEnvelope({ ...result, status: 'failed' }, { error: { code: `static_site.${published.code}`, message: published.message } });
      process.exit(1);
    }

    spinner!.fail(`Rollback to revision ${revision} did not complete`);
    console.error(chalk.red(published.message));
    process.exit(1);
  });

export const deploymentsCommand = new Command('deployments')
  .description('Manage deployments')
  .addCommand(lsCommand)
  .addCommand(rollbackCommand);
