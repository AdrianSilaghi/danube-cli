import type { ApiClient } from './api-client.js';
import { ApiError, UsageError } from './errors.js';
import type { ServerlessContainer } from '../types/api.js';
import type { EnvMap, SecretChanges } from './env-input.js';

export type { EnvMap };

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
 * The secret changes that can change anything. Secret values are write-only, so
 * a value to set always counts; removing a name the container does not hold is
 * a no-op and must not make `apply` report an update.
 */
export function effectiveSecretChanges(
  changes: SecretChanges,
  existingKeys: readonly string[] | null | undefined,
): SecretChanges {
  const held = new Set(existingKeys ?? []);
  return Object.fromEntries(Object.entries(changes).filter(([key, value]) => value !== null || held.has(key)));
}

const SECRETS_UNSUPPORTED =
  'This platform does not support secret variables yet, so nothing was changed. Try again once the platform has been updated.';

/**
 * A platform that predates secret variables ignores the field without an error
 * and says nothing in its answer, so a write would report success and drop the
 * secrets (and `--rm-env X --secret X` would delete X). Only a container that
 * lists `secret_environment_keys` belongs to a platform that stores them. The
 * list endpoint may omit the field, so the container is read once more before
 * giving up. Returns the container to write against.
 */
export async function ensureSecretSupport(api: ApiClient, container: ServerlessContainer): Promise<ServerlessContainer> {
  if (container.secret_environment_keys !== undefined) return container;

  const fresh = await api.get<{ container?: ServerlessContainer }>(`/api/v1/serverless/${container.id}`);
  if (fresh.container?.secret_environment_keys === undefined) throw new UsageError(SECRETS_UNSUPPORTED);
  return fresh.container;
}

/**
 * After a create: the container must report every secret that was sent. One that
 * does not was made without them, which is worse than not being made.
 */
export function assertSecretsStored(container: ServerlessContainer, sent: readonly string[]): void {
  if (sent.length === 0) return;

  const stored = new Set(container.secret_environment_keys ?? []);
  const missing = sent.filter((key) => !stored.has(key));
  if (missing.length === 0) return;

  throw new Error(
    `Container ${container.name} (${container.id}) was created WITHOUT ${missing.length === sent.length ? 'its' : 'some of its'} secret variables: ` +
    `the platform did not report ${missing.join(', ')}. ${container.secret_environment_keys === undefined ? 'It does not support secret variables yet. ' : ''}` +
    'Delete the container, or set the secrets once the platform supports them.',
  );
}

export interface KindReconciliation {
  /** `--rm-env` plus the plain variables that are becoming secrets. */
  rmEnv: string[];
  /** The requested secret changes plus the removal of secrets that are becoming plain. */
  secrets: SecretChanges;
  /** One line per key that changes kind, for the user. */
  notes: string[];
}

/**
 * A key is plain or secret, never both, and the API refuses a request that
 * leaves it in both. Setting a key as a secret that is plain now (or as plain
 * one that is secret now) means moving it, so the removal from the old kind
 * goes in the same write instead of failing with a 422.
 */
export function reconcileKinds(
  container: Pick<ServerlessContainer, 'environment_variables' | 'secret_environment_keys'>,
  env: EnvMap,
  secrets: SecretChanges,
  rmEnv: readonly string[] | undefined,
): KindReconciliation {
  const plainNow = container.environment_variables ?? {};
  const secretNow = new Set(container.secret_environment_keys ?? []);
  const removed = new Set(rmEnv ?? []);

  const toSecret = Object.keys(secrets).filter((key) => secrets[key] !== null && key in plainNow && !removed.has(key));
  const toPlain = Object.keys(env).filter((key) => secretNow.has(key) && !(key in secrets));

  return {
    rmEnv: [...(rmEnv ?? []), ...toSecret],
    secrets: { ...secrets, ...Object.fromEntries(toPlain.map((key) => [key, null])) },
    notes: [
      ...toSecret.map((key) => `moved ${key} from plain to secret`),
      ...toPlain.map((key) => `moved ${key} from secret to plain`),
    ],
  };
}

/**
 * PUT a container with `environment_variables` merged from what the container
 * holds now. The API needs the `environment_snapshot` of the response the merge
 * was built from (required when the container has service connections), so it
 * goes out with the map. If the environment changed in between, read the
 * container again, merge again and retry once.
 *
 * `merge` is null for a change to secrets alone: the plain variables are left
 * out of the request, and the snapshot still goes with it.
 */
export async function putMergedEnvironment<T>(
  api: ApiClient,
  current: ServerlessContainer,
  merge: ((existing: EnvMap | null) => EnvMap) | null,
  body: Record<string, unknown>,
): Promise<T> {
  const send = (from: ServerlessContainer): Promise<T> =>
    api.put<T>(`/api/v1/serverless/${from.id}`, {
      ...body,
      ...(merge ? { environment_variables: merge(from.environment_variables) } : {}),
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
