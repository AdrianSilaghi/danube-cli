import { UsageError } from './errors.js';

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * Parse a human duration — `30m`, `90s`, `2h`, `1500ms` — into milliseconds.
 *
 * A bare number is milliseconds, matching the existing `--timeout <ms>` flags
 * so the two spellings cannot mean different things on the same command line.
 *
 * Rejects rather than guesses: `--timeout 30x` silently falling back to a
 * default is how a caller ends up believing it waited half an hour when it
 * waited ten seconds.
 *
 * Zero is rejected by default — a wait/timeout of zero is never what a caller
 * meant. Pass `{ allowZero: true }` for a field where zero is meaningful (e.g.
 * a scale-down delay of 0, "release immediately") — see parseDurationSeconds.
 */
export function parseDuration(input: string, options: { allowZero?: boolean } = {}): number {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(input.trim());

  if (!match) {
    throw new UsageError(`Invalid duration '${input}'. Use a number of milliseconds, or a suffix: 90s, 30m, 2h.`);
  }

  const value = Number.parseInt(match[1]!, 10);
  const unit = match[2] ?? 'ms';

  if (value === 0 && !options.allowZero) {
    throw new UsageError('A timeout must be greater than zero.');
  }

  return value * UNITS[unit]!;
}

/**
 * Parse a human duration — `0`, `30s`, `5m`, `1h` — into whole seconds, for a
 * flag whose API field is seconds (e.g. --scale-down-delay). Unlike
 * parseDuration()'s default, zero is valid: several of these fields mean
 * "immediately" / "disabled" at zero.
 *
 * Rejects a duration that isn't a whole number of seconds (e.g. `500ms`)
 * rather than silently rounding it — the same "reject, don't guess" reason
 * parseDuration() rejects an unrecognised suffix.
 */
export function parseDurationSeconds(input: string): number {
  const ms = parseDuration(input, { allowZero: true });

  if (ms % 1000 !== 0) {
    throw new UsageError(`Invalid duration '${input}': must be a whole number of seconds (e.g. 0, 30s, 5m, 1h).`);
  }

  return ms / 1000;
}
