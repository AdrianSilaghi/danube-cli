import { UsageError } from './errors.js';
import { readInput, STDIN_SOURCE } from './read-input.js';

export type EnvMap = Record<string, string>;

/** KEY -> value to set, or `null` to remove the secret (the API merges and treats null as removal). */
export type SecretChanges = Record<string, string | null>;

export interface EnvironmentFlags {
  env?: string[];
  envFile?: string;
  secret?: string[];
  secretFile?: string;
  rmSecret?: string[];
}

export interface EnvironmentInput {
  /** Plain variables from `--env-file`, then `--env` on top. */
  env: EnvMap;
  /** Secrets to set (string) or remove (null). Empty when no secret flag was given. */
  secrets: SecretChanges;
}

const DOTENV_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const DOUBLE_QUOTE_ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

/**
 * Read one dotenv value that starts after `=`: unquoted (an inline ` #` comment
 * ends it), 'single' (literal) or "double" (\n \r \t \" \\ escapes). Nothing is
 * interpolated: `$HOME` stays the five characters it is.
 */
function parseValue(raw: string, where: string): string {
  const text = raw.trimStart();
  const quote = text[0];

  if (quote !== '"' && quote !== "'") {
    // A comment starts at whitespace + `#` (so `KEY= # note` is empty, `KEY=a#b` is "a#b"); `raw` still has that whitespace.
    return raw.replace(/\s+#.*$/, '').trim();
  }

  let value = '';
  for (let i = 1; i < text.length; i++) {
    const char = text[i]!;

    if (char === quote) {
      const rest = text.slice(i + 1).trim();
      if (rest !== '' && !rest.startsWith('#')) {
        throw new UsageError(`${where}: unexpected text after the closing quote.`);
      }
      return value;
    }

    if (quote === '"' && char === '\\' && i + 1 < text.length) {
      const next = text[i + 1]!;
      value += DOUBLE_QUOTE_ESCAPES[next] ?? `\\${next}`;
      i++;
      continue;
    }

    value += char;
  }

  throw new UsageError(`${where}: the quoted value is not closed on this line.`);
}

/** dotenv text: `KEY=VALUE`, `#` comments, blank lines, an optional `export `. One line, one variable. */
export function parseDotenv(text: string, source: string): EnvMap {
  const result: EnvMap = {};

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) return;

    const where = `${source}:${index + 1}`;
    const assignment = line.replace(/^export\s+/, '');
    const eq = assignment.indexOf('=');
    const key = eq === -1 ? '' : assignment.slice(0, eq).trim();

    if (!DOTENV_KEY.test(key)) {
      throw new UsageError(`${where}: expected KEY=VALUE.`);
    }

    result[key] = parseValue(assignment.slice(eq + 1), where);
  });

  return result;
}

/**
 * `KEY=VALUE` takes the value as given; a bare `KEY` takes it from the
 * CLI's own environment, so a secret never has to appear on the command line.
 * An unset bare `KEY` is an error: silently sending nothing would deploy
 * without the variable.
 *
 * A refused argument is named by its position, never quoted: the variadic flag
 * swallows a value typed after the key (`--secret DB_PASSWORD hunter2`), and
 * the error would put `hunter2` in a CI log.
 */
export function parsePairs(pairs: string[] | undefined, flag: string, environ: NodeJS.ProcessEnv): EnvMap {
  const result: EnvMap = {};

  (pairs ?? []).forEach((pair, index) => {
    const eq = pair.indexOf('=');

    if (eq > 0) {
      result[pair.slice(0, eq)] = pair.slice(eq + 1);
      return;
    }

    const value = eq === -1 && pair !== '' ? environ[pair] : undefined;
    if (value === undefined) {
      throw new UsageError(
        `Invalid env format: ${flag} argument ${index + 1} is not KEY=VALUE, and is not the name of a variable set in your environment. ` +
        'Use KEY=VALUE, or KEY to read it from your environment.',
      );
    }
    result[pair] = value;
  });

  return result;
}

async function readDotenvFile(path: string, flag: string): Promise<EnvMap> {
  if (path.trim() === '') {
    throw new UsageError(`${flag} needs a path, or - for the standard input.`);
  }
  return parseDotenv(await readInput(path, { sizeHint: 'an environment file is a few KB, so this is probably the wrong file.' }), path === STDIN_SOURCE ? 'the standard input' : path);
}

/**
 * The environment a command was asked for: a file's variables with `--env` on
 * top of them (the flag is the more specific, so it wins), and the secret
 * changes — `--secret-file`, then `--secret`, then `--rm-secret`, which is a
 * null. A key set and removed in one command is a contradiction, and a key
 * both plain and secret is refused here as the API would refuse it.
 */
export async function readEnvironmentFlags(
  flags: EnvironmentFlags,
  environ: NodeJS.ProcessEnv = process.env,
): Promise<EnvironmentInput> {
  if (flags.envFile === STDIN_SOURCE && flags.secretFile === STDIN_SOURCE) {
    throw new UsageError('--env-file and --secret-file cannot both read the standard input.');
  }

  const env: EnvMap = {
    ...(flags.envFile === undefined ? {} : await readDotenvFile(flags.envFile, '--env-file')),
    ...parsePairs(flags.env, '--env', environ),
  };

  const secretValues: EnvMap = {
    ...(flags.secretFile === undefined ? {} : await readDotenvFile(flags.secretFile, '--secret-file')),
    ...parsePairs(flags.secret, '--secret', environ),
  };

  const secrets: SecretChanges = { ...secretValues };
  for (const key of flags.rmSecret ?? []) {
    if (key in secretValues) {
      throw new UsageError(`${key} is both set (--secret) and removed (--rm-secret).`);
    }
    secrets[key] = null;
  }

  const both = Object.keys(secretValues).find((key) => key in env);
  if (both !== undefined) {
    throw new UsageError(`${both} is given as both a plain variable and a secret; choose one.`);
  }

  return { env, secrets };
}

/** Only the secrets that carry a value: what a brand-new container is created with (there is nothing to remove). */
export function secretsToSet(secrets: SecretChanges): EnvMap {
  return Object.fromEntries(Object.entries(secrets).filter((entry): entry is [string, string] => entry[1] !== null));
}
