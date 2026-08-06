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
  /**
   * A major bump is breaking by definition, so it is never installed for you
   * and it is announced differently. Without this the CLI cheerfully nudged
   * 0.18.0 → 1.0.1 in the same words it uses for a patch, while that upgrade
   * renamed every finding code.
   */
  isMajor: boolean;
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

/**
 * Would moving to `latest` cross a major boundary?
 *
 * `0.x` is treated as if every minor were a major, which is the semver
 * convention for pre-1.0: 0.17 → 0.18 may break, and nothing in a 0.x series
 * promises otherwise. Being wrong in this direction only costs an extra
 * prompt; being wrong the other way installs a breaking change unasked.
 */
export function isMajorUpgrade(current: string, latest: string): boolean {
  const [cMajor = 0, cMinor = 0] = current.split('.').map(Number);
  const [lMajor = 0, lMinor = 0] = latest.split('.').map(Number);

  if (lMajor !== cMajor) return true;

  return cMajor === 0 && lMinor !== cMinor;
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
    await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 });
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
        isMajor: isMajorUpgrade(current, cache.latest),
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
      isMajor: isMajorUpgrade(current, latest),
    };
  } catch {
    return null;
  }
}

/**
 * A major upgrade is announced as breaking and points at the changelog, not
 * just at an install command. The previous wording described 0.18.0 → 1.0.1 —
 * which renames every diagnostic finding code — exactly like a patch bump.
 */
export function printUpdateNotification(current: string, latest: string, isMajor = false): void {
  console.error();

  if (isMajor) {
    console.error(chalk.yellow(`  Update available: ${chalk.dim(current)} → ${chalk.green(latest)}  ${chalk.red('(MAJOR — breaking)')}`));
    console.error(chalk.dim('  Read what changed before upgrading: https://docs.danubedata.ro/failure-codes'));
  } else {
    console.error(chalk.yellow(`  Update available: ${chalk.dim(current)} → ${chalk.green(latest)}`));
  }

  console.error(chalk.yellow(`  Run ${chalk.cyan('danube upgrade')} to update`));
  console.error();
}

/** Printed after the CLI has already installed the update for you. */
export function printAutoUpdateNotice(from: string, to: string): void {
  console.error();
  console.error(chalk.green(`  Auto-updated ${chalk.dim(from)} → ${chalk.bold(to)}`));
  console.error(chalk.dim('  Disable with: danube config set auto-update false'));
  console.error();
}
