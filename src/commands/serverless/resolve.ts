import { ApiClient } from '../../lib/api-client.js';
import type { PaginatedResponse, ServerlessContainer } from '../../types/api.js';

export async function resolveContainer(
  api: ApiClient,
  nameOrId: string,
): Promise<ServerlessContainer> {
  // Fetch all containers (high per_page to avoid pagination issues)
  const res = await api.get<PaginatedResponse<ServerlessContainer>>('/api/v1/serverless?per_page=200');

  // Match by exact name or UUID prefix
  const match = res.data.find(
    (c) => c.name === nameOrId || c.slug === nameOrId || c.id === nameOrId || c.id.startsWith(nameOrId),
  );

  if (!match) {
    throw new Error(`Container '${nameOrId}' not found.`);
  }

  return match;
}
