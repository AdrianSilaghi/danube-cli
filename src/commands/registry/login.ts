import { hostname } from 'node:os';
import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { UsageError } from '../../lib/errors.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import { runDocker } from '../../lib/docker-cli.js';
import { fetchAllPages } from '../../lib/paginate.js';
import type { RegistryAccessKey } from '../../types/api.js';
import { createRegistryAccessKey, KEYS_PATH, readScope, resolveExpiry, revokeRegistryAccessKey } from './keys.js';

const KEY_NAME_MAX = 120;
/** A login on a laptop should not leave a push credential that outlives the machine's interest in it. Re-running `registry login` renews. */
const DEFAULT_EXPIRES_IN = '90d';

/** Docker's own login is replaced by each `login`, so the keys an earlier one made on this machine are orphans. They are recognised by this prefix. */
const keyNamePrefix = (): string => `danube-cli-${hostname().replace(/[^A-Za-z0-9.-]/g, '-')}-`;

/** A name for a key made without --name: this machine and this moment, which keeps it unique and recognisable in the console. */
function defaultKeyName(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return `${keyNamePrefix()}${stamp}`.slice(0, KEY_NAME_MAX);
}

/** Docker is asked for its server, which is what a login needs; the client alone answers `docker --version`. */
const DAEMON_CHECK_TIMEOUT_MS = 15_000;
/** A login that needs a keychain prompt nobody sees would otherwise hang with a live key behind it. */
const DOCKER_LOGIN_TIMEOUT_MS = 120_000;

interface Renewal { revoked: number; failed: number; unlisted: boolean }

/**
 * After a login that worked, the keys earlier `registry login` runs on this machine made are no longer
 * in Docker: revoke them. Only active keys with this machine's default name prefix, never the new one.
 * Best effort: a failure is a warning, not a failed login.
 */
async function revokePreviousLoginKeys(api: ApiClient, current: RegistryAccessKey): Promise<Renewal> {
  const prefix = keyNamePrefix();
  let keys: RegistryAccessKey[];
  try {
    keys = (await fetchAllPages<RegistryAccessKey>(api, `${KEYS_PATH}?active=true`)).items;
  } catch {
    return { revoked: 0, failed: 0, unlisted: true };
  }

  const previous = keys.filter((k) => k.id !== current.id && !k.revoked_at && k.name.startsWith(prefix));
  const results = await Promise.all(previous.map((k) => revokeRegistryAccessKey(api, k.id).then(() => true, () => false)));
  return { revoked: results.filter(Boolean).length, failed: results.filter((ok) => !ok).length, unlisted: false };
}

interface RegistryContextResponse { data: { registry_host: string } }

export const loginCommand = new Command('login')
  .description('Create a registry access key and sign Docker in with it')
  .option('--scope <scope>', 'push_pull (default) pushes and pulls; pull only pulls')
  .option('--name <name>', 'Name for the key, unique in the project (default: danube-cli-<this host>-<time>)')
  .option('--expires-in <duration>', `Expire after this long, e.g. 90m, 24h, 30d (default: ${DEFAULT_EXPIRES_IN})`)
  .option('--expires-at <date>', 'Expire at this date (ISO 8601, in the future)')
  .action(async (opts: { scope?: string; name?: string; expiresIn?: string; expiresAt?: string }) => {
    // Same flags, same parsers as `registry keys create`.
    const scope = readScope(opts.scope ?? 'push_pull');
    const expiresAt = resolveExpiry(opts.expiresAt ? opts : { ...opts, expiresIn: opts.expiresIn ?? DEFAULT_EXPIRES_IN });
    const name = opts.name ?? defaultKeyName();

    // Before the key exists: a key made for a machine without a working Docker would be lost, its token shown once.
    let daemon;
    try {
      daemon = await runDocker(['version', '--format', '{{.Server.Version}}'], undefined, { timeoutMs: DAEMON_CHECK_TIMEOUT_MS });
    } catch {
      throw new UsageError('Docker was not found on your PATH. Install it, then run this again; no key was created.');
    }
    if (daemon.code !== 0) {
      throw new UsageError(
        `Docker is installed but its daemon did not answer${daemon.timedOut ? ' in time' : ''}. Start Docker, then run this again; no key was created.`,
      );
    }

    const api = await ApiClient.create();
    const registryHost = (await api.get<RegistryContextResponse>('/api/v1/registry/context')).data.registry_host;

    const { key, token } = await createRegistryAccessKey(api, { name, scope, expiresAt });
    // The token travels on docker's standard input only: not argv, not its environment, not our output.
    const login = await runDocker(['login', registryHost, '-u', key.username, '--password-stdin'], token, { timeoutMs: DOCKER_LOGIN_TIMEOUT_MS }).catch((err: Error) => ({
      code: null as number | null,
      stdout: '',
      stderr: err.message,
      timedOut: false,
    }));

    // Docker's output is scrubbed of the token before it is shown or quoted.
    const scrub = (text: string): string => text.split(token).join('***').trim();

    if (login.code !== 0) {
      // The token is gone with this process, so a key left behind would be a live push credential nobody holds.
      const revoked = await revokeRegistryAccessKey(api, key.id).then(() => true, () => false);
      throw new Error(
        `docker login failed${login.code === null ? '' : ` (exit ${login.code})`}: ${login.timedOut ? 'it did not finish within 2 minutes and was stopped' : scrub(login.stderr || login.stdout) || 'no output'}\n` +
        (revoked
          ? `The key '${key.name}' was created and has been revoked again.`
          : `The key '${key.name}' (id ${key.id}) was created and its token cannot be shown again, and revoking it failed. ` +
            `Revoke it with: danube registry keys rm ${key.id}`) +
        ' Run this again once docker login works.',
      );
    }

    // Docker's own warnings (where it keeps the login, whether that is encrypted) are the user's to read.
    const warnings = scrub(login.stderr);
    if (warnings) console.error(chalk.dim(warnings));

    // Docker now holds this key, so the ones this machine's earlier logins made are dead weight.
    const renewal = await revokePreviousLoginKeys(api, key);

    if (isJsonMode()) {
      jsonOutput({
        registry_host: registryHost,
        username: key.username,
        key,
        docker_login: 'succeeded',
        previous_keys_revoked: renewal.revoked,
        previous_keys_failed: renewal.failed,
      });
      return;
    }

    console.log(chalk.green(`Docker is signed in to ${registryHost}`));
    console.log(`Key:     ${key.name} (${key.scope}${key.expires_at ? `, expires ${key.expires_at}` : ', until revoked'})`);
    console.log(chalk.dim('Docker holds the token (see its output above for where); it is not shown again and the CLI keeps no copy.'));
    if (renewal.revoked > 0) console.log(`Revoked ${renewal.revoked} earlier login key${renewal.revoked === 1 ? '' : 's'} from this machine.`);
    if (renewal.unlisted) console.error(chalk.yellow('Could not list the keys, so earlier login keys from this machine were not revoked. See: danube registry keys ls'));
    if (renewal.failed > 0) console.error(chalk.yellow(`Could not revoke ${renewal.failed} earlier login key${renewal.failed === 1 ? '' : 's'}. See: danube registry keys ls`));
    if (key.expires_at) console.log(chalk.dim('To renew before it expires, run danube registry login again: it revokes this key then.'));
  });
