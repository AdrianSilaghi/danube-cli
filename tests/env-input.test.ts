import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { parseDotenv, parsePairs, readEnvironmentFlags, secretsToSet } from '../src/lib/env-input.js';
import { UsageError } from '../src/lib/errors.js';

describe('parseDotenv', () => {
  it('reads KEY=VALUE lines, skipping comments and blank lines, with an optional export', () => {
    const text = ['# settings', '', 'A=1', 'export B=two', '  C = padded value  ', 'EMPTY=', 'URL=http://h/?a=b#frag'].join('\n');

    expect(parseDotenv(text, '.env')).toEqual({ A: '1', B: 'two', C: 'padded value', EMPTY: '', URL: 'http://h/?a=b#frag' });
  });

  it('cuts an unquoted value at a space-hash comment', () => {
    expect(parseDotenv('A=1 # note\nB=2\t# tab note', '.env')).toEqual({ A: '1', B: '2' });
  });

  it('reads an empty value followed by a comment as empty, and keeps a hash with no space before it', () => {
    expect(parseDotenv('A= # fill me\nB=a # c\nC=a#b\nD=#b\nE=  \t # c', '.env')).toEqual({ A: '', B: 'a', C: 'a#b', D: '#b', E: '' });
  });

  it('reads single quotes literally and double quotes with escapes', () => {
    const text = [`A='raw \\n $HOME #not-a-comment'`, 'B="line\\nbreak \\"quoted\\" \\\\ \\q"', `C="x" # trailing`].join('\n');

    expect(parseDotenv(text, '.env')).toEqual({
      A: 'raw \\n $HOME #not-a-comment',
      B: 'line\nbreak "quoted" \\ \\q',
      C: 'x',
    });
  });

  it('does not interpolate', () => {
    expect(parseDotenv('A=${B}\nB=$HOME', '.env')).toEqual({ A: '${B}', B: '$HOME' });
  });

  it('keeps a quoted value exactly, hash, spaces and escapes included, and an empty value empty', () => {
    expect(parseDotenv('A="  x # y  "\nB=\'  z \'\nC=\nD=""', '.env')).toEqual({ A: '  x # y  ', B: '  z ', C: '', D: '' });
  });

  it('reads Windows line endings', () => {
    expect(parseDotenv('A=1\r\nB=2\r\n', '.env')).toEqual({ A: '1', B: '2' });
  });

  it('lets a later line win', () => {
    expect(parseDotenv('A=1\nA=2', '.env')).toEqual({ A: '2' });
  });

  it.each([
    ['no equals sign', 'JUST_A_WORD', /\.env:1: expected KEY=VALUE/],
    ['no key', '=value', /\.env:1: expected KEY=VALUE/],
    ['a bad key', 'A B=1', /\.env:1: expected KEY=VALUE/],
    ['an unclosed quote', 'OK=1\nA="open', /\.env:2: the quoted value is not closed/],
    ['text after a closing quote', "A='x' y", /\.env:1: unexpected text after the closing quote/],
  ])('names the line for %s', (_name, text, message) => {
    expect(() => parseDotenv(text, '.env')).toThrow(message);
  });
});

describe('parsePairs', () => {
  it('takes KEY=VALUE as given, splitting at the first equals sign', () => {
    expect(parsePairs(['A=b=c', 'EMPTY='], '--env', {})).toEqual({ A: 'b=c', EMPTY: '' });
  });

  it('takes KEY= as the empty string, not as a removal', () => {
    expect(parsePairs(['EMPTY='], '--secret', {})).toStrictEqual({ EMPTY: '' });
  });

  it('takes a bare KEY from the environment, an empty value included', () => {
    expect(parsePairs(['FROM_ENV', 'BLANK'], '--env', { FROM_ENV: 'v', BLANK: '' })).toEqual({ FROM_ENV: 'v', BLANK: '' });
  });

  it('is empty without pairs', () => {
    expect(parsePairs(undefined, '--env', {})).toEqual({});
  });

  it('refuses a bare KEY that is not set, naming the flag and the position', () => {
    expect(() => parsePairs(['OK=1', 'MISSING'], '--secret', {})).toThrow(/Invalid env format: --secret argument 2 is not KEY=VALUE/);
  });

  it.each(['=value', '', 'hunter2'])('refuses %j without quoting it', (pair) => {
    const failure = (() => {
      try {
        parsePairs([pair], '--secret', { '': 'x' });
      } catch (err) {
        return err as Error;
      }
      throw new Error('expected a refusal');
    })();

    expect(failure.message).toMatch(/--secret argument 1/);
    // A value typed after the key (`--secret DB_PASSWORD hunter2`) must not reach a log.
    if (pair !== '') expect(failure.message).not.toContain(pair);
  });
});

describe('readEnvironmentFlags', () => {
  let dir: string | null = null;
  const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;

  afterEach(async () => {
    Object.defineProperty(process, 'stdin', originalStdin);
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  const file = async (name: string, content: string): Promise<string> => {
    dir ??= await mkdtemp(join(tmpdir(), 'danube-env-input-'));
    const path = join(dir, name);
    await writeFile(path, content);
    return path;
  };

  it('lets --env override the file, and keeps plain and secret apart', async () => {
    const envFile = await file('plain.env', 'A=file\nB=file\n');
    const secretFile = await file('secret.env', 'S1=file\nS2=file\n');

    const result = await readEnvironmentFlags(
      { envFile, env: ['B=flag', 'C'], secretFile, secret: ['S2=flag'], rmSecret: ['OLD'] },
      { C: 'from-environ' },
    );

    expect(result).toEqual({
      env: { A: 'file', B: 'flag', C: 'from-environ' },
      secrets: { S1: 'file', S2: 'flag', OLD: null },
    });
  });

  it('reads the standard input for -', async () => {
    Object.defineProperty(process, 'stdin', { value: Readable.from([Buffer.from('FROM_STDIN=yes\n')]), configurable: true });

    expect((await readEnvironmentFlags({ envFile: '-' })).env).toEqual({ FROM_STDIN: 'yes' });
  });

  it('names the standard input in a parse error', async () => {
    Object.defineProperty(process, 'stdin', { value: Readable.from([Buffer.from('oops\n')]), configurable: true });

    await expect(readEnvironmentFlags({ secretFile: '-' })).rejects.toThrow(/the standard input:1: expected KEY=VALUE/);
  });

  it('is empty without flags', async () => {
    expect(await readEnvironmentFlags({})).toEqual({ env: {}, secrets: {} });
  });

  it('refuses both files reading the standard input', async () => {
    await expect(readEnvironmentFlags({ envFile: '-', secretFile: '-' })).rejects.toThrow(/cannot both read the standard input/);
  });

  it('does not mention bucket statements when an env file is too large', async () => {
    const big = await file('big.env', `A=${'x'.repeat(300 * 1024)}\n`);

    const failure = await readEnvironmentFlags({ envFile: big }).catch((e: Error) => e);

    expect((failure as Error).message).toMatch(/is larger than 256 KiB; an environment file is a few KB/);
    expect((failure as Error).message).not.toMatch(/bucket/);
  });

  it('refuses an empty path', async () => {
    await expect(readEnvironmentFlags({ envFile: ' ' })).rejects.toThrow(/--env-file needs a path/);
  });

  it('names an unreadable file', async () => {
    await expect(readEnvironmentFlags({ envFile: '/nonexistent/danube.env' })).rejects.toThrow(/Cannot read \/nonexistent\/danube\.env/);
  });

  it('refuses a key that is both set and removed as a secret', async () => {
    await expect(readEnvironmentFlags({ secret: ['K=1'], rmSecret: ['K'] }, {})).rejects.toBeInstanceOf(UsageError);
  });

  it('refuses a key that is both plain and secret', async () => {
    await expect(readEnvironmentFlags({ env: ['K=1'], secret: ['K=2'] }, {})).rejects.toThrow(/K is given as both a plain variable and a secret/);
  });
});

describe('secretsToSet', () => {
  it('drops the removals', () => {
    expect(secretsToSet({ A: '1', B: null })).toEqual({ A: '1' });
  });
});
