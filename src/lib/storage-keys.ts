import type { ApiClient } from './api-client.js';
import { fetchAllPages } from './paginate.js';
import { ResourceNotFoundError, UsageError } from './errors.js';
import type { StorageAccessKey, StorageKeyLevel, StorageKeyScope } from '../types/api.js';

export const KEY_SCOPES: readonly StorageKeyScope[] = ['team', 'buckets', 'none'];
export const KEY_LEVELS: readonly StorageKeyLevel[] = ['read', 'readwrite', 'full'];

/** The most buckets one key can be limited to. */
export const MAX_BUCKET_PERMISSIONS = 50;

const LEVELS_TEXT = 'read, readwrite or full';
const SCOPES_TEXT = 'team, buckets or none';

export interface BucketGrantSpec {
  /** A bucket name or id, exactly as it was typed. */
  bucket: string;
  level: StorageKeyLevel;
}

export interface KeyScopeRequest {
  /** `undefined` when no scope was asked for: the API then makes a team key. */
  scope: StorageKeyScope | undefined;
  grants: BucketGrantSpec[];
}

const isLevel = (value: string): value is StorageKeyLevel => (KEY_LEVELS as readonly string[]).includes(value);
const isScope = (value: string): value is StorageKeyScope => (KEY_SCOPES as readonly string[]).includes(value);

/** A level, or a usage error naming the flag it was given to. */
export function parseKeyLevel(value: string, flag: string): StorageKeyLevel {
  if (!isLevel(value)) {
    throw new UsageError(`Invalid ${flag} '${value}': use ${LEVELS_TEXT}.`);
  }

  return value;
}

/**
 * One `--bucket <bucket>:<level>`. Split at the LAST colon, so the level is
 * always what follows it. No level is ever assumed: a missing one is an error,
 * because the level is the whole point of the grant.
 */
export function parseBucketGrant(value: string): BucketGrantSpec {
  const colon = value.lastIndexOf(':');

  if (colon === -1) {
    throw new UsageError(
      `Invalid --bucket '${value}': expected <bucket>:<level>, for example invoices:readwrite (level: ${LEVELS_TEXT}).`,
    );
  }

  const bucket = value.slice(0, colon).trim();
  const level = value.slice(colon + 1).trim();

  if (bucket === '') {
    throw new UsageError(`Invalid --bucket '${value}': it names no bucket. Expected <bucket>:<level>, for example invoices:readwrite.`);
  }

  if (!isLevel(level)) {
    const given = level === '' ? 'it gives no level' : `'${level}' is not a level`;
    throw new UsageError(`Invalid --bucket '${value}': ${given}. Use ${LEVELS_TEXT}.`);
  }

  return { bucket, level };
}

/**
 * The flags of `keys create` that say where the key reaches, checked against
 * each other and against what the API accepts.
 *
 * `--bucket` without `--scope buckets` is refused, never taken to mean it: an
 * API that guessed a scope from a list of buckets would hand a key that reaches
 * every bucket to someone who asked for one, and that is the failure to avoid.
 */
export function readKeyScopeFlags(scope: string | undefined, bucketSpecs: string[]): KeyScopeRequest {
  const grants = bucketSpecs.map(parseBucketGrant);

  if (scope === undefined) {
    if (grants.length > 0) {
      throw new UsageError(
        '--bucket needs --scope buckets: a key created without a scope reaches every bucket of the team, so the CLI does not assume one. Add --scope buckets.',
      );
    }

    return { scope: undefined, grants: [] };
  }

  if (!isScope(scope)) {
    throw new UsageError(`Invalid --scope '${scope}': use ${SCOPES_TEXT}.`);
  }

  if (scope !== 'buckets') {
    if (grants.length > 0) {
      const reason = scope === 'team' ? 'a team key reaches every bucket' : 'a key with scope none has no access of its own';
      throw new UsageError(`--scope ${scope} takes no --bucket: ${reason}. Use --scope buckets to limit a key to chosen buckets.`);
    }

    return { scope, grants: [] };
  }

  if (grants.length === 0) {
    throw new UsageError('--scope buckets needs at least one --bucket <bucket>:<level>, for example --bucket invoices:read.');
  }

  if (grants.length > MAX_BUCKET_PERMISSIONS) {
    throw new UsageError(`A key can be limited to at most ${MAX_BUCKET_PERMISSIONS} buckets; got ${grants.length}.`);
  }

  return { scope, grants };
}

/** A key a grant can still go to: not revoked and not past its expiry date. */
const isUsable = (key: StorageAccessKey): boolean => key.status === 'active' && key.is_expired !== true;

const stateOf = (key: StorageAccessKey): string => (key.status === 'active' && key.is_expired === true ? 'expired' : key.status);

/**
 * One key out of the several that answer to the same reference.
 *
 * A key that cannot be used is not a choice: rotating a key (create a new one
 * under the same name, revoke the old) must not leave its name ambiguous for
 * ever. Only when more than one USABLE key remains is it a person's call, and
 * then nothing is guessed.
 */
function choose(matches: StorageAccessKey[], reference: string): StorageAccessKey {
  const usable = matches.filter(isUsable);
  const candidates = usable.length > 0 ? usable : matches;

  if (candidates.length === 1) return candidates[0]!;

  // Id, name and state only: nothing here can be a secret.
  const lines = candidates.map((k) => `  ${k.id}  ${k.name}  ${stateOf(k)}`).join('\n');

  throw new UsageError(`Ambiguous key '${reference}' — ${candidates.length} keys match:\n${lines}\nUse the key's id.`);
}

/**
 * An access key by its id, its S3 access key id or its name, in that order of
 * precedence, from the project's key list.
 *
 * Exact matches only: a prefix of an id is not a key, because what is chosen
 * here is who gets access to a bucket.
 */
export async function resolveAccessKey(api: ApiClient, reference: string): Promise<StorageAccessKey> {
  if (!reference.trim()) {
    throw new UsageError('Empty key given. Name the key by its id, its access key id or its name.');
  }

  const { items, total } = await fetchAllPages<StorageAccessKey>(api, '/api/v1/storage/access-keys');

  const tiers = [
    items.filter((k) => k.id === reference),
    items.filter((k) => k.access_key_id === reference),
    items.filter((k) => k.name === reference),
  ];
  const matches = tiers.find((tier) => tier.length > 0);

  if (matches) return choose(matches, reference);

  const suffix = total > items.length ? ` Note: only ${items.length} of ${total} were searched. Try the key's id.` : '';

  throw new ResourceNotFoundError(
    `access key '${reference}' not found. Name a key by its id, its access key id or its name; \`danube storage keys ls\` lists them.${suffix}`,
  );
}
