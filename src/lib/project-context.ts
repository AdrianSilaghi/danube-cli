import { UsageError } from './errors.js';

/**
 * The project (team) a single invocation runs against.
 *
 * Project selection used to be re-implemented per command, which meant a flag
 * honoured by one subcommand was silently ignored by the next. It is a
 * REQUEST concern — it decides the `X-Team-Id` header — so it lives once, at
 * the root, and every command inherits it.
 *
 * A flag applies to ONE invocation and never mutates saved config. Automation
 * that runs against several projects in sequence must not leave a persistent
 * selection behind for the next process to inherit.
 */
let override: number | null = null;

/**
 * Precedence, highest first:
 *   1. explicit --project / --team flag  (this invocation only)
 *   2. DANUBE_TEAM_ID                    (CI environment)
 *   3. saved selection in the config file
 *   4. the account default, server-side
 *
 * 1 is handled here; 2 and 3 stay in config.getTeamId(), and 4 is the API's
 * behaviour when no header is sent.
 */
export function setProjectOverride(id: number | null): void {
  override = id;
}

export function getProjectOverride(): number | null {
  return override;
}

/**
 * Parse and validate the canonical `--project` flag and its `--team` alias.
 *
 * Supplying both with different values is a usage error rather than a silent
 * precedence rule: guessing which one the caller meant is how automation ends
 * up pointed at the wrong project without anyone noticing.
 */
export function resolveProjectFlag(opts: { project?: unknown; team?: unknown }): number | null {
  const hasProject = opts.project !== undefined && opts.project !== null;
  const hasTeam = opts.team !== undefined && opts.team !== null;

  if (hasProject && hasTeam) {
    if (String(opts.project) !== String(opts.team)) {
      throw new UsageError(
        'Conflicting project selectors: --project and --team were supplied with different values. Use --project.',
      );
    }
    return parseProjectId(opts.project);
  }

  if (hasProject) return parseProjectId(opts.project);
  if (hasTeam) return parseProjectId(opts.team);

  return null;
}

/**
 * Project IDs are positive integers. Automation is told to use numeric IDs
 * precisely because names are ambiguous across accounts, so anything else is
 * rejected loudly rather than coerced — `Number('12abc')` is NaN and
 * `parseInt('12abc')` is 12, and neither is an acceptable guess.
 */
export function parseProjectId(value: unknown): number {
  const raw = String(value).trim();

  if (!/^\d+$/.test(raw)) {
    throw new UsageError(
      `Invalid project id "${raw}". Expected a positive integer — use \`danube project ls\` to find it.`,
    );
  }

  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new UsageError(`Invalid project id "${raw}". Expected a positive integer.`);
  }

  return id;
}
