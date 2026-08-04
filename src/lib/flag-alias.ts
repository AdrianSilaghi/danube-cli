import { UsageError } from './errors.js';

/**
 * Pick one value from a canonical flag and its ergonomic aliases.
 *
 * The CLI grew short, friendly flag names (`--plan`, `--network`) that do not
 * match the API field names they populate (`resource_profile`,
 * `network_stack`). That is fine for a human typing commands and actively
 * hostile to an agent reading the API reference, which reaches for the
 * documented name and gets "unknown option".
 *
 * So both are accepted, and only the canonical FIELD name is ever sent to the
 * REST API — aliases are a CLI-surface convenience, never a wire format.
 *
 * Supplying two aliases with different values is an error rather than a
 * precedence rule. Silently preferring one would provision something the
 * caller did not ask for, with no signal that it happened.
 *
 * @param canonical Name of the canonical flag, used in the error message.
 * @param values    Candidate `[flagName, value]` pairs, canonical first.
 */
export function resolveAlias<T>(
  canonical: string,
  values: Array<[string, T | undefined]>,
): T | undefined {
  const supplied = values.filter(([, value]) => value !== undefined && value !== null);

  if (supplied.length === 0) {
    return undefined;
  }

  const distinct = new Set(supplied.map(([, value]) => String(value)));

  if (distinct.size > 1) {
    const detail = supplied.map(([flag, value]) => `${flag}=${String(value)}`).join(', ');
    throw new UsageError(
      `Conflicting values for ${canonical}: ${detail}. Supply only one — prefer --${canonical}.`,
    );
  }

  return supplied[0]![1];
}
