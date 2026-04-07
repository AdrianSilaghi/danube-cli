import { Command } from 'commander';
import { ApiClient } from '../../lib/api-client.js';
import { formatTable, statusColor, formatDate } from '../../lib/output.js';
import { resolveContainer } from './resolve.js';
import type { PaginatedResponse, ServerlessDeployment } from '../../types/api.js';

export const deploymentsCommand = new Command('deployments')
  .description('List deployments for a serverless container')
  .argument('<name-or-id>', 'Container name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const container = await resolveContainer(api, nameOrId);

    const res = await api.get<PaginatedResponse<ServerlessDeployment>>(
      `/api/v1/serverless/${container.id}/deployments`,
    );

    if (res.data.length === 0) {
      console.log('No deployments yet.');
      return;
    }

    const rows = res.data.map((d) => [
      `#${d.revision_number}`,
      statusColor(d.status) + (d.is_current ? ' (current)' : ''),
      `${d.image}:${d.image_tag}`,
      `${d.traffic_percent}%`,
      d.deployed_at ? formatDate(d.deployed_at) : '-',
    ]);

    console.log(formatTable(['REVISION', 'STATUS', 'IMAGE', 'TRAFFIC', 'DEPLOYED'], rows));
  });
