import { hostname } from 'node:os';
import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { ApiError, UsageError } from '../../lib/errors.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import { runDocker } from '../../lib/docker-cli.js';
import { readConfig, getTeamId } from '../../lib/config.js';
import { getProjectOverride } from '../../lib/project-context.js';
import { acquireLoginLock, dockerConfigDir, readLoginKeys, writeLoginKeys } from '../../lib/registry-logins.js';
import type { LoginKeyRecord } from '../../lib/registry-logins.js';
import type { RegistryAccessKey, TeamsResponse } from '../../types/api.js';
import { createRegistryAccessKey, readScope, resolveExpiry, revokeRegistryAccessKey } from './keys.js';

const KEY_NAME_MAX = 120;
/** A login on a laptop should not leave a push credential that outlives the machine's interest in it. Re-running `registry login` renews. */
const DEFAULT_EXPIRES_IN = '90d';

/** A name for a key made without --name: this machine and this moment, which keeps it unique and recognisable in the console. */
function defaultKeyName(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return `danube-cli-${hostname().replace(/[^A-Za-z0-9.-]/g, '-')}-${stamp}`.slice(0, KEY_NAME_MAX);
}

/** Only the client has to run: `docker login` can work without a daemon (a credential store, a remote context). */
const DOCKER_CHECK_TIMEOUT_MS = 15_000;
/** A login that needs a keychain prompt nobody sees would otherwise hang with a live key behind it. */
const DOCKER_LOGIN_TIMEOUT_MS = 120_000;

/** The project a new key is created in: the one the request is scoped to, else the account's current one. Null when neither can be learned. */
async function currentTeamId(api: ApiClient): Promise<number | null> {
  const chosen = getProjectOverride() ?? getTeamId(await readConfig());
  if (chosen !== null) return chosen;

  try {
    return (await api.get<TeamsResponse>('/api/v1/user/teams')).current_team_id ?? null;
  } catch {
    return null;
  }
}

interface Renewal {
  /** True when every key the last login(s) here made is gone, false when one could not be revoked, null when none was recorded. */
  previousKeyRevoked: boolean | null;
  message: string | null;
  /** Whether the new key was recorded, so the next login here can revoke it. */
  recorded: boolean;
  /** Something the user should look at: a revoke that failed, a key that could not be found, or a record that could not be made. */
  warn: boolean;
}

type Revocation = { kind: 'done' } | { kind: 'lost' } | { kind: 'failed'; message: string };

/**
 * Revoke one recorded key in the project it belongs to. A 404 in a project the record names means it
 * is already gone, which is what was wanted. A 404 for a record with no project only means it is not in
 * the project this request is for: it may be alive in another one, so it is not reported as revoked.
 */
async function revokeRecorded(api: ApiClient, record: LoginKeyRecord, currentTeam: number | null): Promise<Revocation> {
  try {
    const client = record.teamId !== null && record.teamId !== currentTeam ? await ApiClient.create({ teamId: record.teamId }) : api;
    await revokeRegistryAccessKey(client, record.keyId);
    return { kind: 'done' };
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 404) return record.teamId === null ? { kind: 'lost' } : { kind: 'done' };
    return { kind: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Docker now holds the new key, so the key the last `registry login` for this Docker config and
 * registry put there is dead weight. Exactly the ids recorded by this command are revoked, each in its
 * own project, and then the new key is recorded. A key that could not be revoked stays recorded, so a
 * later login tries again. Best effort: nothing here fails a login that worked.
 */
async function renewLogin(api: ApiClient, key: RegistryAccessKey, registryHost: string, teamId: number | null): Promise<Renewal> {
  const dockerDir = dockerConfigDir();
  const previous = (await readLoginKeys(dockerDir, registryHost)).filter((r) => r.keyId !== key.id);
  const outcomes = await Promise.all(previous.map((r) => revokeRecorded(api, r, teamId)));
  // Only a failure is worth another try. A key that was not found is dropped: retrying would never end.
  const kept = previous.filter((_, i) => outcomes[i]!.kind === 'failed');

  let recorded = true;
  try {
    await writeLoginKeys(dockerDir, registryHost, [...kept, { keyId: key.id, teamId }]);
  } catch {
    recorded = false;
  }

  const problems = outcomes.flatMap((o) => (o.kind === 'failed' ? [o.message] : []));
  const lost = outcomes.filter((o) => o.kind === 'lost').length;
  const done = outcomes.filter((o) => o.kind === 'done').length;
  const parts = [
    ...(done > 0 ? [`Revoked the ${done === 1 ? 'key' : `${done} keys`} the earlier login here made.`] : []),
    ...(problems.length > 0 ? [`Could not revoke ${problems.length === 1 ? 'an earlier login key' : `${problems.length} earlier login keys`} (${problems.join('; ')}); the next login will try again.`] : []),
    ...(lost > 0 ? [`${lost === 1 ? 'An earlier login key was' : `${lost} earlier login keys were`} not found in the current project; ${lost === 1 ? 'it' : 'they'} may live in another project, so check \`danube registry keys ls --project <id>\`. ${lost === 1 ? 'It is' : 'They are'} no longer tracked.`] : []),
    ...(recorded ? [] : ['Could not record this key, so the next login will not revoke it.']),
  ];

  return {
    previousKeyRevoked: problems.length > 0 ? false : previous.length === 0 || lost > 0 ? null : true,
    message: parts.length > 0 ? parts.join(' ') : null,
    recorded,
    warn: problems.length > 0 || lost > 0 || !recorded,
  };
}

/** What a login reports when it could not take the lock: nothing was revoked or recorded, and the user can do it by hand. */
const SKIPPED: Renewal = {
  previousKeyRevoked: null,
  message: 'Another registry login is running here, so this one did not renew: the earlier key was not revoked and this key was not recorded. See: danube registry keys ls',
  recorded: false,
  warn: true,
};

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
    let docker;
    try {
      docker = await runDocker(['--version'], undefined, { timeoutMs: DOCKER_CHECK_TIMEOUT_MS });
    } catch {
      throw new UsageError('Docker was not found on your PATH. Install it, then run this again; no key was created.');
    }
    if (docker.code !== 0) {
      throw new UsageError(`Docker could not be run${docker.timedOut ? ' (it did not answer in time)' : ''}. Fix it, then run this again; no key was created.`);
    }

    const api = await ApiClient.create();
    const registryHost = (await api.get<RegistryContextResponse>('/api/v1/registry/context')).data.registry_host;

    const { key, token } = await createRegistryAccessKey(api, { name, scope, expiresAt });
    // Held from just before docker login to the record write: two logins into one Docker config
    // must not each revoke the key the other left in Docker. Without it, nothing is revoked or recorded.
    const lock = await acquireLoginLock();
    let renewal: Renewal;
    let warnings: string;
    try {
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

      warnings = scrub(login.stderr);
      // Docker now holds this key: the one the last login here put there is no longer needed.
      renewal = lock ? await renewLogin(api, key, registryHost, await currentTeamId(api)) : SKIPPED;
    } finally {
      await lock?.release();
    }

    // Docker's own warnings (where it keeps the login, whether that is encrypted) are the user's to read.
    if (warnings) console.error(chalk.dim(warnings));

    if (isJsonMode()) {
      jsonOutput({
        registry_host: registryHost,
        username: key.username,
        key,
        docker_login: 'succeeded',
        previous_key_revoked: renewal.previousKeyRevoked,
        previous_key_message: renewal.message,
        key_recorded: renewal.recorded,
      });
      return;
    }

    console.log(chalk.green(`Docker is signed in to ${registryHost}`));
    console.log(`Key:     ${key.name} (${key.scope}${key.expires_at ? `, expires ${key.expires_at}` : ', until revoked'})`);
    console.log(chalk.dim('Docker holds the token (see its output above for where); it is not shown again and the CLI keeps no copy.'));
    if (renewal.message) {
      // A warning when something could not be done, plain news otherwise.
      if (renewal.warn) console.error(chalk.yellow(renewal.message));
      else console.log(renewal.message);
    }
    if (key.expires_at) console.log(chalk.dim('To renew before it expires, run danube registry login again: it revokes this key then.'));
  });
