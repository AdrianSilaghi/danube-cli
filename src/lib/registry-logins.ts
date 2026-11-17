import { readFile, writeFile, mkdir, rename, rm, open, stat, realpath } from 'node:fs/promises';
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
/** A `docker login` may take two minutes, so a lock younger than three belongs to a login that is still running. */
const LOCK_STALE_MS = 180_000;
const LOCK_POLL_MS = 100;

/**
 * Serialise logins: from just before `docker login` to the write of the record, so two logins into
 * the same slot cannot each revoke the key the other one left in Docker. A lock file created
 * exclusively next to the store. Resolves null when it cannot be had within `waitMs` (or at all): the
 * caller must then not revoke or record anything. A lock older than `staleMs` is the leftover of a
 * login that died, and is broken.
 */
export async function acquireLoginLock(
  file: string = DEFAULT_FILE,
  options: { waitMs?: number; staleMs?: number; pollMs?: number } = {},
): Promise<LoginLock | null> {
  const { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS, pollMs = LOCK_POLL_MS } = options;
  const path = `${file}.lock`;
  const startedAt = Date.now();

  try {
    await mkdir(dirname(file), { recursive: true });
  } catch {
    return null;
  }

  for (;;) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return { release: () => rm(path, { force: true }) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
    }

    const age = await stat(path).then((s) => Date.now() - s.mtimeMs, () => null);
    if (age === null) continue; // It went away between the two calls: try to take it.
    if (age > staleMs) {
      await rm(path, { force: true });
      continue;
    }
    if (Date.now() - startedAt >= waitMs) return null;
    await sleep(pollMs);
  }
}
