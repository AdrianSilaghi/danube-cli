import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { fetchAllPages } from '../../lib/paginate.js';
import { formatTable, statusColor, formatDate } from '../../lib/output.js';
import { resolveContainer } from './resolve.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import type { ServerlessDeployment } from '../../types/api.js';

export const deploymentsCommand = new Command('deployments')
  .description('List deployments for a serverless container')
  .argument('<name-or-id>', 'Container name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const container = await resolveContainer(api, nameOrId);

    const { items, total, truncated } = await fetchAllPages<ServerlessDeployment>(
      api,
      `/api/v1/serverless/${container.id}/deployments`,
    );

    if (isJsonMode()) {
      jsonOutput(items);
      return;
    }

    if (items.length === 0) {
      console.log('No deployments yet.');
      return;
    }

    const rows = items.map((d) => [
      `#${d.revision_number}`,
      statusColor(d.status) + (d.is_current ? ' (current)' : ''),
      `${d.image}:${d.image_tag}`,
      `${d.traffic_percent}%`,
      d.deployed_at ? formatDate(d.deployed_at) : '-',
    ]);

    console.log(formatTable(['REVISION', 'STATUS', 'IMAGE', 'TRAFFIC', 'DEPLOYED'], rows));

    if (truncated) {
      console.log(chalk.dim(`Showing ${items.length} of ${total}. Refine with the web console for the full list.`));
    }
  });
