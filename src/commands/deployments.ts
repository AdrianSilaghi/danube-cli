import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../lib/api-client.js';
import { readProjectConfig } from '../lib/project.js';
import { NotLinkedError } from '../lib/errors.js';
import { formatTable, statusColor, formatDate } from '../lib/output.js';
import type { PaginatedResponse, StaticSiteDeployment, MessageResponse } from '../types/api.js';

const lsCommand = new Command('ls')
  .description('List deployments')
  .action(async () => {
    const project = await readProjectConfig();
    if (!project) throw new NotLinkedError();

    const api = await ApiClient.create();
    const res = await api.get<PaginatedResponse<StaticSiteDeployment>>(
      `/api/v1/static-sites/${project.siteId}/deployments`,
    );

    if (res.data.length === 0) {
      console.log('No deployments yet.');
      return;
    }

    const rows = res.data.map(d => [
      `#${d.revision_number}`,
      statusColor(d.status) + (d.is_current ? chalk.cyan(' (current)') : ''),
      d.trigger_type,
      d.deployed_at ? formatDate(d.deployed_at) : '-',
      formatDate(d.created_at),
    ]);

    console.log(formatTable(['REVISION', 'STATUS', 'TRIGGER', 'DEPLOYED', 'CREATED'], rows));
  });

const rollbackCommand = new Command('rollback')
  .description('Activate a previous deployment')
  .argument('<revision>', 'Deployment revision number')
  .action(async (revision: string) => {
    const project = await readProjectConfig();
    if (!project) throw new NotLinkedError();

    const api = await ApiClient.create();

    // Find deployment by revision
    const deploymentsRes = await api.get<PaginatedResponse<StaticSiteDeployment>>(
      `/api/v1/static-sites/${project.siteId}/deployments`,
    );

    const deployment = deploymentsRes.data.find(d => d.revision_number === Number(revision));
    if (!deployment) {
      console.error(chalk.red(`Deployment revision ${revision} not found.`));
      process.exit(1);
    }

    const spinner = ora(`Rolling back to revision ${revision}...`).start();
    await api.post<MessageResponse>(
      `/api/v1/static-sites/${project.siteId}/deployments/${deployment.id}/activate`,
    );

    spinner.succeed(`Rolled back to revision ${revision}`);
  });

export const deploymentsCommand = new Command('deployments')
  .description('Manage deployments')
  .addCommand(lsCommand)
  .addCommand(rollbackCommand);
