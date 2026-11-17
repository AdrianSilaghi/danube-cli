import { hostname } from 'node:os';
import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { UsageError } from '../../lib/errors.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import { runDocker } from '../../lib/docker-cli.js';
import { createRegistryAccessKey, readScope, resolveExpiry, revokeRegistryAccessKey } from './keys.js';

const KEY_NAME_MAX = 120;
/** A login on a laptop should not leave a push credential that outlives the machine's interest in it. Re-running `registry login` renews. */
const DEFAULT_EXPIRES_IN = '90d';

/** A name for a key made without --name: this machine and this moment, which keeps it unique and recognisable in the console. */
function defaultKeyName(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return `danube-cli-${hostname().replace(/[^A-Za-z0-9.-]/g, '-')}-${stamp}`.slice(0, KEY_NAME_MAX);
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

    // Before the key exists: a key made for a machine without Docker would be lost, its token shown once.
    try {
      await runDocker(['--version']);
    } catch {
      throw new UsageError('Docker was not found on your PATH. Install it, then run this again; no key was created.');
    }

    const api = await ApiClient.create();
    const registryHost = (await api.get<RegistryContextResponse>('/api/v1/registry/context')).data.registry_host;

    const { key, token } = await createRegistryAccessKey(api, { name, scope, expiresAt });
    // The token travels on docker's standard input only: not argv, not its environment, not our output.
    const login = await runDocker(['login', registryHost, '-u', key.username, '--password-stdin'], token).catch((err: Error) => ({
      code: null as number | null,
      stdout: '',
      stderr: err.message,
    }));

    // Docker's output is scrubbed of the token before it is shown or quoted.
    const scrub = (text: string): string => text.split(token).join('***').trim();

    if (login.code !== 0) {
      // The token is gone with this process, so a key left behind would be a live push credential nobody holds.
      const revoked = await revokeRegistryAccessKey(api, key.id).then(() => true, () => false);
      throw new Error(
        `docker login failed${login.code === null ? '' : ` (exit ${login.code})`}: ${scrub(login.stderr || login.stdout) || 'no output'}\n` +
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

    if (isJsonMode()) {
      jsonOutput({ registry_host: registryHost, username: key.username, key, docker_login: 'succeeded' });
      return;
    }

    console.log(chalk.green(`Docker is signed in to ${registryHost}`));
    console.log(`Key:     ${key.name} (${key.scope}${key.expires_at ? `, expires ${key.expires_at}` : ', until revoked'})`);
    console.log(chalk.dim('Docker holds the token (see its output above for where); it is not shown again and the CLI keeps no copy.'));
    if (key.expires_at) console.log(chalk.dim('To renew before it expires, run danube registry login again.'));
  });
