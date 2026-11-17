import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { CONFIG_DIR } from './config.js';

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

const slot = (dockerDir: string, registryHost: string): string => `${dockerDir}\n${registryHost}`;

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
  const records = (await readStore(file))[slot(dockerDir, registryHost)];
  return Array.isArray(records) ? records.filter((r) => typeof r?.keyId === 'string') : [];
}

/** Replace what is recorded for this Docker config and registry. An empty list forgets it. Rejects when the file cannot be written. */
export async function writeLoginKeys(
  dockerDir: string,
  registryHost: string,
  records: readonly LoginKeyRecord[],
  file: string = DEFAULT_FILE,
): Promise<void> {
  const store = await readStore(file);
  if (records.length === 0) delete store[slot(dockerDir, registryHost)];
  else store[slot(dockerDir, registryHost)] = [...records];

  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
}
