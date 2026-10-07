import { Command } from 'commander';
import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import { input } from '@inquirer/prompts';
import { ApiClient } from '../../lib/api-client.js';
import { fetchAllPages } from '../../lib/paginate.js';
import { resolveResources } from '../../lib/resolve.js';
import { formatTable, statusColor, formatDate, printDetails } from '../../lib/output.js';
import { isJsonMode, jsonOutput, jsonError } from '../../lib/json-mode.js';
import { promptOr, confirmDestruction } from '../../lib/interactive.js';
import { ApiError, UsageError } from '../../lib/errors.js';
import { refuseRepeatedFlags, singleValue } from '../../lib/single-value-flag.js';
import { keyState, readKeyScopeFlags, type BucketGrantSpec } from '../../lib/storage-keys.js';
import type {
  StorageAccessKey,
  StorageBucket,
  StorageKeyBucketPermission,
  StorageKeyScope,
  CreateAccessKeyResponse,
  MessageResponse,
} from '../../types/api.js';

/** The state of a key, coloured: a key past its expiry date is `expired`, not the `active` the API still calls it. */
const stateText = (key: StorageAccessKey): string => {
  const state = keyState(key);

  return state === 'expired' ? chalk.yellow(state) : statusColor(state);
};

const lsCommand = new Command('ls')
  .description('List all access keys')
  .action(async () => {
    const api = await ApiClient.create();
    const { items, total, truncated } = await fetchAllPages<StorageAccessKey>(api, '/api/v1/storage/access-keys');

    if (isJsonMode()) {
      jsonOutput(items);
      return;
    }

    if (items.length === 0) {
      console.log('No access keys found.');
      return;
    }

    // The ID is what `get`, `revoke` and `storage policy grant --key` take. The
    // ARN stays in `get`: it is too long for a table.
    const rows = items.map(k => [
      k.id,
      k.name,
      k.access_key_id,
      k.scope ?? '-',
      stateText(k),
      k.expires_at ? formatDate(k.expires_at) : 'never',
      k.last_used_at ? formatDate(k.last_used_at) : '-',
      formatDate(k.created_at),
    ]);

    console.log(formatTable(['ID', 'NAME', 'ACCESS KEY', 'SCOPE', 'STATUS', 'EXPIRES', 'LAST USED', 'CREATED'], rows));

    if (truncated) {
      console.log(chalk.dim(`Showing ${items.length} of ${total}. Refine with the web console for the full list.`));
    }
  });

interface CreateOptions {
  name?: string;
  expires?: string;
  scope?: string;
  bucket?: string[];
}

/** Repeating `--bucket` adds to the list; the list is never changed in place. */
const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

/**
 * The buckets named in `--bucket`, each as the bucket itself, by exact name or
 * full id: this decides which buckets a key may reach, so the beginning of an id
 * is not a name. One reading of the bucket list serves them all. Naming one
 * bucket twice, whether both times by name or once by name and once by id, is
 * refused: two levels for one bucket is not something to pick between.
 */
async function resolveGrantedBuckets(api: ApiClient, grants: BucketGrantSpec[]): Promise<StorageBucket[]> {
  const buckets = await resolveResources<StorageBucket>(
    api,
    '/api/v1/storage/buckets',
    'bucket',
    grants.map((g) => g.bucket),
    { exact: true },
  );
  const seen = new Set<string>();

  for (const bucket of buckets) {
    if (seen.has(bucket.id)) {
      throw new UsageError(`Bucket '${bucket.name}' is listed twice in --bucket. Give each bucket once, with the level you want.`);
    }
    seen.add(bucket.id);
  }

  return buckets;
}

/**
 * What goes over the wire. A key is only given a `scope` when one was asked
 * for, so an old-style create (`--name`, `--expires`) sends exactly what it
 * always sent — and still makes a team key.
 */
function createBody(
  name: string,
  expires: string | undefined,
  scope: StorageKeyScope | undefined,
  grants: BucketGrantSpec[],
  buckets: StorageBucket[],
): Record<string, unknown> {
  return {
    name,
    ...(expires ? { expires_at: expires } : {}),
    ...(scope ? { scope } : {}),
    ...(scope === 'buckets'
      ? { bucket_permissions: grants.map((grant, i) => ({ bucket_id: buckets[i]!.id, level: grant.level })) }
      : {}),
  };
}

const revokeCommandFor = (id: string): string => `danube storage keys revoke ${id} --yes`;

/** Best effort: whether the key was revoked, and if not, why. */
async function tryToRevoke(api: ApiClient, id: string): Promise<{ revoked: true } | { revoked: false; reason: string }> {
  try {
    await api.delete<MessageResponse>(`/api/v1/storage/access-keys/${encodeURIComponent(id)}`);
    return { revoked: true };
  } catch (err) {
    return { revoked: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The platform answered with a key of another scope than the one asked for. It
 * should never happen, but if it does the key it made may reach every bucket.
 * The secret is not shown, so nobody can use that key, and the command revokes
 * it rather than leave a broader key behind: `keys revoke` asks to confirm, so
 * it could not even be run from a script. Exits 1 whether or not that worked.
 */
async function failScopeNotApplied(
  api: ApiClient,
  res: CreateAccessKeyResponse,
  requested: StorageKeyScope,
  spinner: Ora | null,
): Promise<never> {
  const reported = res.scope ?? null;

  spinner?.fail('The key was created, but not with the scope you asked for');
  const outcome = await tryToRevoke(api, res.id);

  const lines = [
    `The server created access key ${res.id} but did not apply the scope you asked for (asked for: ${requested}; the server reported: ${reported ?? 'no scope'}).`,
    'A key that is not limited as requested may reach every bucket of the team, so its secret is not shown.',
    ...(outcome.revoked
      ? ['The key has been revoked.']
      : [`The key could not be revoked: ${outcome.reason}`, `Revoke it now: ${revokeCommandFor(res.id)}`]),
  ];

  if (isJsonMode()) {
    jsonError({
      code: 'storage.key_scope_not_applied',
      message: lines.join(' '),
      id: res.id,
      requested_scope: requested,
      reported_scope: reported,
      revoked: outcome.revoked,
      revoke_command: revokeCommandFor(res.id),
    });
  } else {
    console.error(chalk.red(lines.join('\n')));
  }

  process.exit(1);
}

/** What a create must answer with for its key to be handed over: an id to revoke it by, and the credentials. */
const isReadable = (res: unknown): res is CreateAccessKeyResponse => {
  if (typeof res !== 'object' || res === null) return false;

  const { id, access_key_id: accessKeyId, secret_access_key: secret } = res as Record<string, unknown>;

  return typeof id === 'string' && typeof accessKeyId === 'string' && typeof secret === 'string';
};

/**
 * A 2xx means the key exists, whatever the body says. An answer that cannot be
 * read must not become a crash that never says so, or "Created access key
 * undefined" with a secret that is `undefined`.
 */
function failAnswerUnreadable(spinner: Ora | null): never {
  const message =
    "The server accepted the request, but its answer could not be read, so the new key's id and secret are unknown. " +
    'The key may exist: run `danube storage keys ls` to look for it, and revoke it if it is there.';

  spinner?.fail('The key may have been created, but the answer could not be read');

  if (isJsonMode()) {
    jsonError({ code: 'storage.key_answer_unreadable', message });
  } else {
    console.error(chalk.red(message));
  }

  process.exit(1);
}

/**
 * The create call. A platform that does not know `--scope none` answers 422 about
 * the scope; that is said as what it means, with what the API said kept.
 */
async function createKey(api: ApiClient, body: Record<string, unknown>, scope: StorageKeyScope | undefined): Promise<unknown> {
  try {
    return await api.post<unknown>('/api/v1/storage/access-keys', body);
  } catch (err) {
    if (scope === 'none' && err instanceof ApiError && err.statusCode === 422 && err.errors?.scope) {
      throw new ApiError(
        422,
        `This platform does not support --scope none yet (the API said: ${err.errors.scope.join(' ')})`,
        err.errors,
        err.cause,
        err.meta,
        err.retryAfterSeconds,
      );
    }

    throw err;
  }
}

const LABEL_WIDTH = 19;

const row = (label: string, value: string): void => {
  console.log(`  ${label ? `${label}:` : ''}`.padEnd(LABEL_WIDTH + 2) + value);
};

/** `invoices (read)`; the id stands in for a bucket that has no name to show. */
const grantText = (name: string | null | undefined, bucketId: string, level: string): string =>
  `${name ?? bucketId} (${level})`;

function printReach(res: CreateAccessKeyResponse, bucketNames: Map<string, string>): void {
  if (res.scope !== undefined) row('Scope', res.scope);

  (res.bucket_permissions ?? []).forEach((p, i) => {
    row(i === 0 ? 'Buckets' : '', grantText(bucketNames.get(p.bucket_id), p.bucket_id, p.level));
  });

  if (res.arn !== undefined) row('ARN', res.arn ?? 'none: signs as the team');
}

/** A key with no access of its own is useless until a policy names it, so the next step is spelled out. */
function printNextStepForNoneKey(res: CreateAccessKeyResponse): void {
  console.log('');
  console.log('  This key has no access of its own: it reaches nothing until a bucket policy allows it.');
  console.log('  Give it a folder, or the whole bucket:');
  console.log(chalk.cyan(`    danube storage policy grant <bucket> --key ${res.id} --folder <folder> --level <read|readwrite|full>`));
  console.log(chalk.cyan(`    danube storage policy grant <bucket> --key ${res.id} --whole-bucket --level <read|readwrite|full>`));
}

const createCommand = new Command('create')
  .description('Create a new access key')
  .option('--name <name>', 'Key name')
  .option('--expires <date>', 'Expiration date (ISO 8601)')
  .option('--scope <scope>', 'Where the key reaches: team (every bucket, the default), buckets (only the --bucket list) or none (nothing, until a bucket policy allows it)', singleValue('--scope'))
  .option('--bucket <bucket:level>', 'With --scope buckets: a bucket (its exact name or full id) and what the key may do there: read, readwrite or full. Repeat for each bucket (at most 50)', collect)
  .hook('preAction', refuseRepeatedFlags)
  .action(async (opts: CreateOptions) => {
    // Checked before anything is asked or sent: a mistake in the flags costs nothing.
    const { scope, grants } = readKeyScopeFlags(opts.scope, opts.bucket ?? []);

    const name = await promptOr('--name', opts.name, () => input({
      message: 'Access key name:',
      validate: (v: string) => v.trim().length > 0 || 'Name is required',
    }));

    const api = await ApiClient.create();
    const buckets = await resolveGrantedBuckets(api, grants);
    const body = createBody(name.trim(), opts.expires, scope, grants, buckets);
    const spinner = isJsonMode() ? null : ora('Creating access key...').start();

    const answer = await createKey(api, body, scope);

    if (!isReadable(answer)) return failAnswerUnreadable(spinner);
    const res = answer;

    // `team` cannot come out broader than a team key, so only the narrower scopes are checked.
    if (scope !== undefined && scope !== 'team' && res.scope !== scope) {
      return failScopeNotApplied(api, res, scope, spinner);
    }

    if (isJsonMode()) {
      jsonOutput({
        id: res.id,
        name: res.name,
        access_key_id: res.access_key_id,
        secret_access_key: res.secret_access_key,
        expires_at: res.expires_at,
        arn: res.arn,
        scope: res.scope,
        bucket_permissions: res.bucket_permissions,
      });
      return;
    }

    spinner!.succeed(`Created access key ${chalk.bold(res.name)}`);

    console.log('');
    console.log(`  Access Key ID:     ${chalk.bold(res.access_key_id)}`);
    console.log(`  Secret Access Key: ${chalk.bold.yellow(res.secret_access_key)}`);
    printReach(res, new Map(buckets.map((b) => [b.id, b.name])));
    if (res.scope === 'none') printNextStepForNoneKey(res);
    console.log('');
    console.log(chalk.yellow('  Save the secret access key now — it will not be shown again.'));
  });

/**
 * Where the key reaches. A server that does not report scope, ARN or buckets
 * leaves them out of the picture entirely, rather than showing blanks.
 */
function reachRows(k: StorageAccessKey): Array<[string, string]> {
  const rows: Array<[string, string]> = [];

  if (k.scope !== undefined) rows.push(['Scope', k.scope]);
  if (k.arn !== undefined) rows.push(['ARN', k.arn ?? 'signs as the team']);

  const buckets: StorageKeyBucketPermission[] = k.bucket_permissions ?? [];
  buckets.forEach((p, i) => rows.push([i === 0 ? 'Buckets' : '', grantText(p.bucket_name, p.bucket_id, p.level)]));

  return rows;
}

const getCommand = new Command('get')
  .description('Show access key details')
  .argument('<key-id>', 'Access key ID')
  .action(async (keyId: string) => {
    const api = await ApiClient.create();
    const res = await api.get<{ access_key: StorageAccessKey }>(`/api/v1/storage/access-keys/${keyId}`);

    if (isJsonMode()) {
      jsonOutput(res.access_key);
      return;
    }

    const k = res.access_key;

    const lines: Array<[string, string]> = [
      ['Name', k.name],
      ['Access Key ID', k.access_key_id],
      ...reachRows(k),
      ['Status', stateText(k)],
      ['Expires', k.expires_at ? formatDate(k.expires_at) : 'never'],
      ['Last Used', k.last_used_at ? formatDate(k.last_used_at) : '-'],
      ['Created', formatDate(k.created_at)],
    ];

    printDetails(lines);

    if (k.scope === 'none') {
      console.log(chalk.dim('No access of its own: this key reaches only what a bucket policy allows.'));
    }
  });

const revokeCommand = new Command('revoke')
  .description('Revoke an access key')
  .argument('<key-id>', 'Access key ID')
  .option('-f, --force', 'Skip confirmation')
  .option('-y, --yes', 'Alias for --force')
  .action(async (keyId: string, opts: { force?: boolean; yes?: boolean }) => {
    const proceed = await confirmDestruction(
      `revocation of key ${keyId}`,
      `Are you sure you want to revoke access key ${keyId}?`,
      opts.force || opts.yes,
    );
    if (!proceed) {
      console.log('Cancelled.');
      return;
    }

    const api = await ApiClient.create();
    const spinner = isJsonMode() ? null : ora('Revoking access key...').start();

    await api.delete<MessageResponse>(`/api/v1/storage/access-keys/${keyId}`);

    if (isJsonMode()) {
      jsonOutput({ status: 'revoked', id: keyId });
      return;
    }
    spinner!.succeed('Access key revoked');
  });

export const keysCommand = new Command('keys')
  .description('Manage storage access keys')
  .addCommand(lsCommand)
  .addCommand(createCommand)
  .addCommand(getCommand)
  .addCommand(revokeCommand);
