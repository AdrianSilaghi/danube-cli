import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client.js';
import { fetchAllPages } from '../../lib/paginate.js';
import { formatTable, statusColor, formatDate, printDetails } from '../../lib/output.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import { confirmDestruction } from '../../lib/interactive.js';
import { ApiError, UsageError } from '../../lib/errors.js';
import { parseDuration } from '../../lib/duration.js';
import type { RegistryAccessKey, RegistryKeyScope, CreateRegistryAccessKeyResponse } from '../../types/api.js';

/**
 * Registry access keys: the credentials `docker login` takes.
 *
 * The token (`cr_...`) is returned by the create call and never again, so it is
 * printed once, only to stdout, and nothing here logs or echoes it elsewhere.
 */

export const KEYS_PATH = '/api/v1/registry/access-keys';
const REGISTRY_HOST = 'cr.danubedata.ro';
const SCOPES: readonly RegistryKeyScope[] = ['push_pull', 'pull'];
const MS_PER_DAY = 86_400_000;

/** A key is `revoked`, `expired` (past its date, not yet revoked) or `active`. */
const keyState = (key: RegistryAccessKey): 'revoked' | 'expired' | 'active' => {
  if (key.revoked_at) return 'revoked';
  if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now()) return 'expired';
  return 'active';
};

const stateText = (key: RegistryAccessKey): string => {
  const state = keyState(key);
  return state === 'expired' ? chalk.yellow(state) : statusColor(state);
};

const lsCommand = new Command('ls')
  .description('List registry access keys')
  .option('--active', 'Only keys that are neither revoked nor expired')
  .action(async (opts: { active?: boolean }) => {
    const api = await ApiClient.create();
    const { items, total, truncated } = await fetchAllPages<RegistryAccessKey>(
      api,
      opts.active ? `${KEYS_PATH}?active=true` : KEYS_PATH,
    );

    if (isJsonMode()) {
      jsonOutput(items);
      return;
    }

    if (items.length === 0) {
      console.log('No registry access keys found.');
      return;
    }

    console.log(
      formatTable(
        ['ID', 'NAME', 'USERNAME', 'SCOPE', 'STATUS', 'EXPIRES', 'LAST USED', 'CREATED'],
        items.map((k) => [
          k.id,
          k.name,
          k.username,
          k.scope,
          stateText(k),
          k.expires_at ? formatDate(k.expires_at) : 'never',
          k.last_used_at ? formatDate(k.last_used_at) : '-',
          formatDate(k.created_at),
        ]),
      ),
    );

    if (truncated) {
      console.log(chalk.dim(`Showing ${items.length} of ${total}.`));
    }
  });

/**
 * The expiry to send, as an ISO date. `--expires-in` is relative to now and takes
 * `90m`, `24h` or `30d`; `--expires-at` is an absolute date. Both is a mistake,
 * not a choice. Whether the date is in the future is the API's to judge.
 */
export function resolveExpiry(opts: { expiresIn?: string; expiresAt?: string }): string | undefined {
  if (opts.expiresIn && opts.expiresAt) {
    throw new UsageError('Use either --expires-in or --expires-at, not both.');
  }

  if (opts.expiresAt) {
    const date = new Date(opts.expiresAt);
    if (Number.isNaN(date.getTime())) {
      throw new UsageError(`Invalid --expires-at '${opts.expiresAt}'. Use an ISO 8601 date, e.g. 2027-01-31T00:00:00Z.`);
    }
    return date.toISOString();
  }

  if (opts.expiresIn) {
    const days = /^(\d+)d$/.exec(opts.expiresIn.trim());
    const ms = days ? Number.parseInt(days[1]!, 10) * MS_PER_DAY : parseDuration(opts.expiresIn);
    if (ms <= 0) throw new UsageError('--expires-in must be greater than zero.');
    return new Date(Date.now() + ms).toISOString();
  }

  return undefined;
}

/** A 2xx whose body cannot be used: the key may exist, and its token is not recoverable. */
class UnreadableKeyAnswer extends Error {}

/** The refusals of the create call that have one fix, said as that fix. */
function explainCreateFailure(err: unknown): unknown {
  if (!(err instanceof ApiError)) return err;

  if (err.statusCode === 404) {
    return new ApiError(
      404,
      'This platform does not offer registry access keys through the API yet. Create one in the console (Container Registry > Access keys).',
      err.errors, err.cause, err.meta,
    );
  }
  if (err.statusCode === 403) {
    return new ApiError(
      403,
      `Creating a registry access key needs the project owner and an API token with the registry:credentials ability. (${err.message})`,
      err.errors, err.cause, err.meta,
    );
  }
  return err;
}

/**
 * Create a key and return it with its token. The one code path under both
 * `registry keys create` and `registry login`.
 */
export async function createRegistryAccessKey(
  api: ApiClient,
  input: { name: string; scope: RegistryKeyScope; expiresAt?: string },
): Promise<CreateRegistryAccessKeyResponse> {
  let res: CreateRegistryAccessKeyResponse;
  try {
    res = await api.post<CreateRegistryAccessKeyResponse>(KEYS_PATH, {
      name: input.name,
      scope: input.scope,
      ...(input.expiresAt ? { expires_at: input.expiresAt } : {}),
    });
  } catch (error) {
    throw explainCreateFailure(error);
  }

  // A 2xx means the key exists. Without the token it is unusable, so say so
  // rather than print "undefined" as a credential.
  if (typeof res?.token !== 'string' || res.token === '' || typeof res?.key?.id !== 'string') {
    throw new UnreadableKeyAnswer(
      'The server accepted the request, but its answer had no key or token. ' +
        'The key may have been created; check `danube registry keys ls`, and revoke it if it is there.',
    );
  }

  return res;
}

/** Revoke a key. The one code path under `registry keys rm` and a failed `registry login`. */
export async function revokeRegistryAccessKey(api: ApiClient, id: string): Promise<RegistryAccessKey> {
  const res = await api.delete<{ data: RegistryAccessKey }>(`${KEYS_PATH}/${encodeURIComponent(id)}`);
  return res.data;
}

export function readScope(scope: string | undefined): RegistryKeyScope {
  if (!scope || !SCOPES.includes(scope as RegistryKeyScope)) {
    throw new UsageError(`--scope is required: ${SCOPES.join(' or ')}.`);
  }
  return scope as RegistryKeyScope;
}

const createCommand = new Command('create')
  .description('Create a registry access key. The token is shown once')
  .argument('<name>', 'Key name (unique in the project, revoked keys included; max 120 characters)')
  .option('--scope <scope>', `What the key may do: ${SCOPES.join(' or ')}`)
  .option('--expires-in <duration>', 'Expire after this long, e.g. 90m, 24h, 30d')
  .option('--expires-at <date>', 'Expire at this date (ISO 8601, in the future)')
  .action(async (name: string, opts: { scope?: string; expiresIn?: string; expiresAt?: string }) => {
    // Checked before anything is sent: a mistake in the flags costs nothing.
    const scope = readScope(opts.scope);
    const expiresAt = resolveExpiry(opts);

    const api = await ApiClient.create();
    const spinner = isJsonMode() ? null : ora('Creating registry access key...').start();

    let res: CreateRegistryAccessKeyResponse;
    try {
      res = await createRegistryAccessKey(api, { name, scope, expiresAt });
    } catch (error) {
      spinner?.fail(error instanceof UnreadableKeyAnswer
        ? 'The key may have been created, but the answer could not be read'
        : 'Could not create the key');
      throw error;
    }

    if (isJsonMode()) {
      jsonOutput({ ...res.key, token: res.token });
      return;
    }

    spinner!.succeed(`Created registry access key ${chalk.bold(res.key.name)}`);
    console.log('');
    console.log(`  ID:        ${res.key.id}`);
    console.log(`  Username:  ${res.key.username}`);
    console.log(`  Scope:     ${res.key.scope}`);
    console.log(`  Expires:   ${res.key.expires_at ? formatDate(res.key.expires_at) : 'never'}`);
    console.log(`  Token:     ${chalk.bold.yellow(res.token)}`);
    console.log('');
    console.log(chalk.yellow('  Save the token now — it will not be shown again.'));
    console.log('');
    console.log('  Log in with it (put the token in $TOKEN first):');
    console.log(chalk.cyan(`    echo "$TOKEN" | docker login ${REGISTRY_HOST} -u ${res.key.username} --password-stdin`));
  });

const revokeCommand = new Command('rm')
  .alias('revoke')
  .description('Revoke a registry access key (repeating it is harmless)')
  .argument('<id>', 'Key ID (from `danube registry keys ls`)')
  .option('-f, --force', 'Skip confirmation')
  .option('-y, --yes', 'Alias for --force')
  .action(async (id: string, opts: { force?: boolean; yes?: boolean }) => {
    const proceed = await confirmDestruction(
      `revocation of key ${id}`,
      `Revoke registry access key ${id}? Anything logged in with it stops working.`,
      opts.force || opts.yes,
    );
    if (!proceed) {
      console.log('Cancelled.');
      return;
    }

    const api = await ApiClient.create();
    const key = await revokeRegistryAccessKey(api, id);

    if (isJsonMode()) {
      jsonOutput(key);
      return;
    }

    console.log(chalk.green(`Registry access key '${key.name}' revoked.`));
    printDetails([
      ['ID', key.id],
      ['Revoked', key.revoked_at ? formatDate(key.revoked_at) : '-'],
    ]);
  });

export const keysCommand = new Command('keys')
  .description('Manage registry access keys (docker login credentials)')
  .addCommand(lsCommand)
  .addCommand(createCommand)
  .addCommand(revokeCommand);
