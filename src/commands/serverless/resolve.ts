import type { ApiClient } from '../../lib/api-client.js';
import { resolveResource } from '../../lib/resolve.js';
import type { ServerlessContainer } from '../../types/api.js';

export async function resolveContainer(api: ApiClient, nameOrId: string): Promise<ServerlessContainer> {
  return resolveResource<ServerlessContainer>(api, '/api/v1/serverless', 'container', nameOrId);
}
