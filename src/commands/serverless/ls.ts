import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { fetchAllPages } from '../../lib/paginate.js';
import { formatTable, statusColor, formatDate } from '../../lib/output.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import type { ServerlessContainer } from '../../types/api.js';

export const lsCommand = new Command('ls')
  .description('List serverless containers')
  .action(async () => {
    const api = await ApiClient.create();
    const { items, total, truncated } = await fetchAllPages<ServerlessContainer>(api, '/api/v1/serverless');

    if (isJsonMode()) {
      jsonOutput(items);
      return;
    }

    if (items.length === 0) {
      console.log('No serverless containers found.');
      return;
    }

    // request/limit straight from the API — the profile name alone hides what
    // is actually enforced inside the pod, and profiles change server-side.
    const rows = items.map((c) => [
      c.name,
      statusColor(c.status),
      c.resource_profile,
      `${c.cpu_request || '-'}/${c.cpu_limit || '-'}`,
      `${c.memory_request || '-'}/${c.memory_limit || '-'}`,
      c.url || '-',
      formatDate(c.created_at),
    ]);

    console.log(formatTable(['NAME', 'STATUS', 'PROFILE', 'CPU', 'MEMORY', 'URL', 'CREATED'], rows));

    if (truncated) {
      console.log(chalk.dim(`Showing ${items.length} of ${total}. Refine with the web console for the full list.`));
    }
  });
