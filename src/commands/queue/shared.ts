import type { ApiClient } from '../../lib/api-client.js';
import { resolveResource } from '../../lib/resolve.js';

export interface QueueInstance {
  id: string;
  name: string;
  status: string;
  provider?: string | null;
  resource_profile?: string | null;
  version?: string | null;
  datacenter?: string | null;
  endpoint?: string | null;
  monthly_cost_dollars?: number | string | null;
  created_at: string;
}

export const LIST_PATH = '/api/v1/queue';

/** `exact` for commands that change credentials or destroy: an id prefix must not pick the queue. */
export function resolveQueue(api: ApiClient, nameOrId: string, exact = false): Promise<QueueInstance> {
  return resolveResource<QueueInstance>(api, LIST_PATH, 'queue', nameOrId, { exact });
}
