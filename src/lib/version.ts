import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

export const PACKAGE_NAME = '@danubedata/cli';

const CACHE_FILE = join(homedir(), '.danube', 'update-check.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface UpdateCache {
  latest: string;
  checkedAt: number;
}

export interface UpdateCheckResult {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

export function getCurrentVersion(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
  const raw = readFileSync(pkgPath, 'utf-8');
  const pkg = JSON.parse(raw) as { version: string };
  return pkg.version;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function readCache(): Promise<UpdateCache | null> {
  try {
    const raw = await readFile(CACHE_FILE, 'utf-8');
    return JSON.parse(raw) as UpdateCache;
  } catch {
    return null;
  }
}

async function writeCache(cache: UpdateCache): Promise<void> {
  try {
    await mkdir(dirname(CACHE_FILE), { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n');
  } catch {
    // Silently ignore write errors
  }
}

export async function checkForUpdate(): Promise<UpdateCheckResult | null> {
  try {
    if (process.env.CI || process.env.DANUBE_NO_UPDATE_CHECK) {
      return null;
    }

    const current = getCurrentVersion();

    const cache = await readCache();
    if (cache && (Date.now() - cache.checkedAt) < CACHE_TTL_MS) {
      return {
        current,
        latest: cache.latest,
        updateAvailable: compareSemver(cache.latest, current) > 0,
      };
    }

    const response = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`);
    if (!response.ok) return null;

    const data = await response.json() as { version: string };
    const latest = data.version;

    await writeCache({ latest, checkedAt: Date.now() });

    return {
      current,
      latest,
      updateAvailable: compareSemver(latest, current) > 0,
    };
  } catch {
    return null;
  }
}

export function printUpdateNotification(current: string, latest: string): void {
  console.log();
  console.log(chalk.yellow(`  Update available: ${chalk.dim(current)} → ${chalk.green(latest)}`));
  console.log(chalk.yellow(`  Run ${chalk.cyan(`npm install -g ${PACKAGE_NAME}`)} to update`));
  console.log();
}
