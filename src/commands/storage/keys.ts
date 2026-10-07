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
import { UsageError } from '../../lib/errors.js';
import { readKeyScopeFlags, type BucketGrantSpec } from '../../lib/storage-keys.js';
import type {
  StorageAccessKey,
  StorageBucket,
  StorageKeyBucketPermission,
  StorageKeyScope,
  CreateAccessKeyResponse,
  MessageResponse,
} from '../../types/api.js';

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
      statusColor(k.status),
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
 * The buckets named in `--bucket`, each as the bucket itself. One reading of the
 * bucket list serves them all. Naming one bucket twice, whether both times by
 * name or once by name and once by id, is refused: two levels for one bucket is
 * not something to pick between.
 */
async function resolveGrantedBuckets(api: ApiClient, grants: BucketGrantSpec[]): Promise<StorageBucket[]> {
  const buckets = await resolveResources<StorageBucket>(api, '/api/v1/storage/buckets', 'bucket', grants.map((g) => g.bucket));
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

/**
 * The server made a key, but not the one that was asked for.
 *
 * An older server ignores a field it does not know and answers with the key it
 * DID create: a team key, which reaches every bucket. That key must not be
 * passed off as a success, and its secret is not shown — the person revokes it.
 */
function failScopeNotApplied(res: CreateAccessKeyResponse, requested: StorageKeyScope, spinner: Ora | null): never {
  const reported = res.scope ?? null;
  const lines = [
    `The server created access key ${res.id} but did not apply the scope you asked for (asked for: ${requested}; the server reported: ${reported ?? 'no scope'}).`,
    'A key that is not limited as requested may reach every bucket of the team, so its secret is not shown.',
    `Revoke it now: danube storage keys revoke ${res.id}`,
  ];

  spinner?.fail('The key was created, but not with the scope you asked for');

  if (isJsonMode()) {
    jsonError({ code: 'storage.key_scope_not_applied', message: lines.join(' '), id: res.id, requested_scope: requested, reported_scope: reported });
  } else {
    console.error(chalk.red(lines.join('\n')));
  }

  process.exit(1);
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
  .option('--scope <scope>', 'Where the key reaches: team (every bucket, the default), buckets (only the --bucket list) or none (nothing, until a bucket policy allows it)')
  .option('--bucket <bucket:level>', 'With --scope buckets: a bucket (name or id) and what the key may do there: read, readwrite or full. Repeat for each bucket (at most 50)', collect)
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

    const res = await api.post<CreateAccessKeyResponse>('/api/v1/storage/access-keys', body);

    // `team` cannot come out broader than a team key, so only the narrower scopes are checked.
    if (scope !== undefined && scope !== 'team' && res.scope !== scope) {
      failScopeNotApplied(res, scope, spinner);
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
      ['Status', statusColor(k.status)],
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
