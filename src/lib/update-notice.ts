import { readConfig } from './config.js';
import { performUpgrade } from './upgrade.js';
import { wantsJsonOutput } from './command-resolution.js';
import {
  checkForUpdate,
  printAutoUpdateNotice,
  printUpdateNotification,
  type UpdateCheckResult,
} from './version.js';

/**
 * How long startup may wait for the registry. Only paid when the cached answer
 * has expired — once per UPDATE_CHECK_TTL_MS — and usually a fraction of it.
 */
export const STARTUP_CHECK_TIMEOUT_MS = 1_000;

export interface UpdateNotice {
  readonly result: UpdateCheckResult | null;
  /** Print the notice if an update is due. Only the first call prints, so it is safe in an exit handler. */
  print(): void;
  /** Suppress the notice — the update has just been installed. */
  dismiss(): void;
}

/** The first positional token, skipping the global options and their values. */
function commandName(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') return undefined;
    if (token === '--project' || token === '--team') {
      i++;
      continue;
    }
    if (!token.startsWith('-')) return token;
  }

  return undefined;
}

/**
 * A person at a terminal, not a script: JSON mode and a redirected stderr are
 * automation. CI and DANUBE_NO_UPDATE_CHECK are opt-outs enforced by
 * checkForUpdate itself, and `danube upgrade` reports on itself.
 */
export function wantsUpdateNotice(argv: readonly string[], stderrIsTTY: boolean): boolean {
  return stderrIsTTY && !wantsJsonOutput(argv) && commandName(argv) !== 'upgrade';
}

/**
 * Check once at startup so every interactive run can carry the notice.
 *
 * The check used to run only after a command succeeded, so `danube`,
 * `danube --help` and every failed command — the moment a fix matters most —
 * never mentioned that a newer version existed.
 */
export async function prepareUpdateNotice(
  argv: readonly string[],
  stderrIsTTY: boolean = Boolean(process.stderr.isTTY),
): Promise<UpdateNotice> {
  const result = wantsUpdateNotice(argv, stderrIsTTY)
    ? await checkForUpdate({ timeoutMs: STARTUP_CHECK_TIMEOUT_MS })
    : null;
  let pending = result?.updateAvailable === true;

  return {
    result,
    print() {
      if (!pending || !result) return;
      pending = false;
      printUpdateNotification(result.current, result.latest, result.isMajor);
    },
    dismiss() {
      pending = false;
    },
  };
}

/**
 * Opt-in, same-major auto-update after a successful command. A major bump
 * renames codes and changes semantics, so it is always announced and never
 * applied. A refusal (version manager, unwritable prefix) leaves the ordinary
 * notice to be printed instead of nagging about plumbing.
 */
export async function autoUpdateIfEnabled(notice: UpdateNotice): Promise<void> {
  const result = notice.result;
  if (!result?.updateAvailable || result.isMajor) return;

  const config = await readConfig().catch(() => null);
  if (config?.autoUpdate !== true) return;

  const outcome = await performUpgrade(result.current, result.latest);
  if (!outcome.ok) return;

  notice.dismiss();
  printAutoUpdateNotice(outcome.from, outcome.to);
}
