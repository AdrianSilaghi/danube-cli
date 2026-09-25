import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

export const PACKAGE_NAME = '@danubedata/cli';

const CACHE_FILE = join(homedir(), '.danube', 'update-check.json');

/**
 * How long a registry answer is trusted. It was 24 hours, so a fix published
 * in the morning reached nobody who had run the CLI the evening before — and
 * `danube upgrade` read the same cache, answering "already on the latest
 * version" for a day after a release.
 */
export const UPDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000;

/** `danube upgrade` is waiting on this answer, so it may take a moment. */
const FORCED_CHECK_TIMEOUT_MS = 10_000;

const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

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

export interface UpdateCheckOptions {
  /**
   * Ask the registry even when a cached answer exists, and even under CI or
   * DANUBE_NO_UPDATE_CHECK. For `danube upgrade`: those opt-outs silence the
   * passive notice; they are no reason to refuse an upgrade asked for by name,
   * which is what reporting "could not reach the npm registry" did.
   */
  force?: boolean;
  /** How long to wait for the registry before giving up. */
  timeoutMs?: number;
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

function toResult(current: string, latest: string): UpdateCheckResult {
  return {
    current,
    latest,
    updateAvailable: compareSemver(latest, current) > 0,
    isMajor: isMajorUpgrade(current, latest),
  };
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

/** The version npm calls `latest`, or null when the registry cannot say. */
async function fetchLatestVersion(timeoutMs: number): Promise<string | null> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;

    const data = await response.json() as { version?: unknown };

    return typeof data.version === 'string' && RELEASE_VERSION.test(data.version) ? data.version : null;
  } catch {
    return null;
  }
}

export async function checkForUpdate(options: UpdateCheckOptions = {}): Promise<UpdateCheckResult | null> {
  const { force = false, timeoutMs = FORCED_CHECK_TIMEOUT_MS } = options;

  try {
    if (!force && (process.env.CI || process.env.DANUBE_NO_UPDATE_CHECK)) {
      return null;
    }

    const current = getCurrentVersion();
    const cache = await readCache();

    if (!force && cache && (Date.now() - cache.checkedAt) < UPDATE_CHECK_TTL_MS) {
      return toResult(current, cache.latest);
    }

    const latest = await fetchLatestVersion(timeoutMs);

    if (latest === null) {
      // Remember the attempt, keeping the last answer: an unreachable registry
      // then costs one timeout per TTL instead of one on every command.
      if (!force) await writeCache({ latest: cache?.latest ?? current, checkedAt: Date.now() });
      return null;
    }

    await writeCache({ latest, checkedAt: Date.now() });

    return toResult(current, latest);
  } catch {
    return null;
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

function visibleLength(text: string): number {
  return text.replace(ANSI_ESCAPE, '').length;
}

/**
 * Lines framed so the notice reads as a message from the CLI rather than the
 * tail of the command's own output. A frame wider than the terminal would wrap
 * into noise, so a narrow terminal gets the plain lines.
 */
function frame(lines: string[], columns: number | undefined): string[] {
  const width = Math.max(...lines.map(visibleLength));

  if (columns !== undefined && width + 6 > columns) {
    return ['', ...lines.map((line) => `  ${line}`), ''];
  }

  const edge = '─'.repeat(width + 2);

  return [
    '',
    chalk.yellow(`  ╭${edge}╮`),
    ...lines.map((line) => `${chalk.yellow('  │')} ${line}${' '.repeat(width - visibleLength(line))} ${chalk.yellow('│')}`),
    chalk.yellow(`  ╰${edge}╯`),
    '',
  ];
}

/**
 * A major upgrade is announced as breaking and points at the changelog, not
 * just at an install command. The previous wording described 0.18.0 → 1.0.1 —
 * which renames every diagnostic finding code — exactly like a patch bump.
 */
export function formatUpdateNotice(
  current: string,
  latest: string,
  isMajor = false,
  columns: number | undefined = process.stderr.columns,
): string[] {
  const versions = `${chalk.dim(current)} → ${chalk.green.bold(latest)}`;

  const lines = isMajor
    ? [
      `A ${chalk.red.bold('MAJOR')} DanubeData CLI release is out: ${versions}`,
      'It may break existing scripts — read what changed first:',
      'https://docs.danubedata.ro/failure-codes',
      `Then run ${chalk.cyan('danube upgrade')}.`,
    ]
    : [
      `A new version of the DanubeData CLI is available: ${versions}`,
      `Run ${chalk.cyan('danube upgrade')} to get the latest features and fixes.`,
    ];

  return frame(lines, columns);
}

export function printUpdateNotification(current: string, latest: string, isMajor = false): void {
  for (const line of formatUpdateNotice(current, latest, isMajor)) {
    console.error(line);
  }
}

/** Printed after the CLI has already installed the update for you. */
export function printAutoUpdateNotice(from: string, to: string): void {
  console.error();
  console.error(chalk.green(`  Auto-updated ${chalk.dim(from)} → ${chalk.bold(to)}`));
  console.error(chalk.dim('  Disable with: danube config set auto-update false'));
  console.error();
}
