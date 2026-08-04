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
 */
export function parseDuration(input: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(input.trim());

  if (!match) {
    throw new UsageError(`Invalid duration '${input}'. Use a number of milliseconds, or a suffix: 90s, 30m, 2h.`);
  }

  const value = Number.parseInt(match[1]!, 10);
  const unit = match[2] ?? 'ms';

  if (value <= 0) {
    throw new UsageError('A timeout must be greater than zero.');
  }

  return value * UNITS[unit]!;
}
