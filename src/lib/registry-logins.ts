import { readFile, writeFile, mkdir, rename, rm, open, lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CONFIG_DIR } from './config.js';
import { sleep } from './sleep.js';

/**
 * Which registry key `danube registry login` put into which Docker login, so the next login can
 * revoke exactly that key and nothing else.
 *
 * A Docker login is one per Docker config directory and registry host: a second `docker login` there
 * replaces the first, which leaves the key behind it unused but alive. A key is only ever recognised
 * by the id recorded here, never by its name (another machine, a CI job or a colleague may have a
 * key named alike). Ids only: the token is not kept, and the file is private to the user.
 */
export interface LoginKeyRecord {
  keyId: string;
  /** The project the key was created in, or null when the CLI could not tell. A revoke is sent to this project. */
  teamId: number | null;
}

type Store = Record<string, LoginKeyRecord[]>;

const DEFAULT_FILE = join(CONFIG_DIR, 'registry-logins.json');

/** Where Docker keeps its login: `DOCKER_CONFIG`, else `~/.docker`. */
export function dockerConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DOCKER_CONFIG || join(homedir(), '.docker');
}

/**
 * One Docker config directory is one slot however it is spelled: a relative path is resolved against
 * the working directory (so `DOCKER_CONFIG=cfg` in two directories is two slots), a symlink is followed
 * when the directory exists, and Windows paths ignore case.
 */
async function slot(dockerDir: string, registryHost: string): Promise<string> {
  let dir = resolve(dockerDir);
  try {
    dir = await realpath(dir);
  } catch {
    // Not created yet: the resolved path is the best name it has.
  }
  return `${process.platform === 'win32' ? dir.toLowerCase() : dir}\n${registryHost}`;
}

async function readStore(file: string): Promise<Store> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8')) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Store) : {};
  } catch {
    // No file yet, or one that is not ours to trust: nothing is recorded.
    return {};
  }
}

/** The keys recorded for this Docker config and registry, oldest first. */
export async function readLoginKeys(dockerDir: string, registryHost: string, file: string = DEFAULT_FILE): Promise<LoginKeyRecord[]> {
  const records = (await readStore(file))[await slot(dockerDir, registryHost)];
  return Array.isArray(records) ? records.filter((r) => typeof r?.keyId === 'string') : [];
}

/**
 * Replace what is recorded for this Docker config and registry. An empty list forgets it. Rejects when
 * the file cannot be written. The new content is written to a private file next to the store and moved
 * over it, so a crash leaves the old store or the new one, never half of one.
 */
export async function writeLoginKeys(
  dockerDir: string,
  registryHost: string,
  records: readonly LoginKeyRecord[],
  file: string = DEFAULT_FILE,
): Promise<void> {
  const store = await readStore(file);
  const key = await slot(dockerDir, registryHost);
  if (records.length === 0) delete store[key];
  else store[key] = [...records];

  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
    await rename(temp, file);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

export interface LoginLock {
  release(): Promise<void>;
}

const LOCK_WAIT_MS = 15_000;
/** The longest a login holds the lock is a two minute `docker login` plus its API calls, so a lock older than five minutes is the leftover of a login that died. */
const LOCK_STALE_MS = 300_000;
const LOCK_POLL_MS = 100;

/**
 * Serialise logins: the caller takes the lock before it creates a key and keeps it to the write of the
 * record, so two logins into the same slot cannot each revoke the key the other one left in Docker.
 * A lock file created exclusively next to the store, holding a random token. Resolves null when it
 * cannot be had within `waitMs`, or at all (any unexpected error: a directory or a dangling symlink at
 * the lock path, no permission): the caller then logs in without renewing, and revokes and records
 * nothing. A lock older than `staleMs` is broken. `release()` removes the lock only while it still holds
 * this login's token, so a lock someone else took after ours was broken is never deleted.
 */
export async function acquireLoginLock(
  file: string = DEFAULT_FILE,
  options: { waitMs?: number; staleMs?: number; pollMs?: number } = {},
): Promise<LoginLock | null> {
  const { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS, pollMs = LOCK_POLL_MS } = options;
  const path = `${file}.lock`;
  const token = randomUUID();
  const startedAt = Date.now();

  try {
    await mkdir(dirname(file), { recursive: true });

    for (;;) {
      try {
        const handle = await open(path, 'wx', 0o600);
        await handle.writeFile(token);
        await handle.close();
        return {
          release: async () => {
            const holder = await readFile(path, 'utf-8').catch(() => null);
            if (holder === token) await rm(path, { force: true });
          },
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      }

      // Every way round the loop passes this check, so no path can wait forever.
      if (Date.now() - startedAt >= waitMs) return null;

      // lstat: what is at the path itself, a dangling symlink included, never what it points to.
      const age = await lstat(path).then((s) => Date.now() - s.mtimeMs, (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null; // It went away between the two calls: try to take it.
        throw err;
      });

      if (age === null) continue;
      if (age > staleMs) {
        await rm(path, { force: true });
        continue;
      }
      await sleep(pollMs);
    }
  } catch {
    return null;
  }
}
