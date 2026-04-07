import { Command } from 'commander';
import { ApiClient } from '../../lib/api-client.js';
import { formatTable, statusColor, formatDate } from '../../lib/output.js';
import type { PaginatedResponse, ServerlessContainer } from '../../types/api.js';

export const lsCommand = new Command('ls')
  .description('List serverless containers')
  .action(async () => {
    const api = await ApiClient.create();
    const res = await api.get<PaginatedResponse<ServerlessContainer>>('/api/v1/serverless');

    if (res.data.length === 0) {
      console.log('No serverless containers found.');
      return;
    }

    const rows = res.data.map((c) => [
      c.name,
      statusColor(c.status),
      c.resource_profile,
      c.url || '-',
      formatDate(c.created_at),
    ]);

    console.log(formatTable(['NAME', 'STATUS', 'PROFILE', 'URL', 'CREATED'], rows));
  });
