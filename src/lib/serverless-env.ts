import type { ApiClient } from './api-client.js';
import { ApiError } from './errors.js';
import type { ServerlessContainer } from '../types/api.js';

export type EnvMap = Record<string, string>;

/** Remove the named keys first, then overlay `pairs` on what is left. */
export function mergeEnv(existing: EnvMap | null | undefined, pairs: EnvMap, rmKeys: string[] | undefined): EnvMap {
  const merged: EnvMap = { ...(existing ?? {}) };
  for (const key of rmKeys ?? []) delete merged[key];
  return { ...merged, ...pairs };
}

/** The API refuses a write whose snapshot is missing or stale with a 422 on one of these fields. */
function isStaleEnvironment(e: unknown): boolean {
  return (
    e instanceof ApiError &&
    e.statusCode === 422 &&
    Boolean(e.errors?.environment_snapshot || e.errors?.environment_variables)
  );
}

/**
 * PUT a container with `environment_variables` merged from what the container
 * holds now. The API needs the `environment_snapshot` of the response the merge
 * was built from (required when the container has service connections), so it
 * goes out with the map. If the environment changed in between, read the
 * container again, merge again and retry once.
 */
export async function putMergedEnvironment<T>(
  api: ApiClient,
  current: ServerlessContainer,
  merge: (existing: EnvMap | null) => EnvMap,
  body: Record<string, unknown>,
): Promise<T> {
  const send = (from: ServerlessContainer): Promise<T> =>
    api.put<T>(`/api/v1/serverless/${from.id}`, {
      ...body,
      environment_variables: merge(from.environment_variables),
      ...(from.environment_snapshot ? { environment_snapshot: from.environment_snapshot } : {}),
    });

  try {
    return await send(current);
  } catch (e) {
    if (!isStaleEnvironment(e)) throw e;
    const fresh = await api.get<{ container: ServerlessContainer }>(`/api/v1/serverless/${current.id}`);
    return send(fresh.container);
  }
}
