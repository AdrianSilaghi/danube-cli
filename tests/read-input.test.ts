import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { readInput, STDIN_SOURCE } from '../src/lib/read-input.js';
import { UsageError } from '../src/lib/errors.js';

const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;

const pipeIntoStdin = (...chunks: Buffer[]): void => {
  Object.defineProperty(process, 'stdin', { value: Readable.from(chunks), configurable: true });
};

/** A terminal: stdin that nothing was piped into. */
const typeIntoStdin = (...chunks: Buffer[]): void => {
  Object.defineProperty(process, 'stdin', { value: Object.assign(Readable.from(chunks), { isTTY: true }), configurable: true });
};

describe('readInput', () => {
  let dir: string | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    Object.defineProperty(process, 'stdin', originalStdin);
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  const fileWith = async (content: string): Promise<string> => {
    dir = await mkdtemp(join(tmpdir(), 'danube-read-input-'));
    const path = join(dir, 'policy.json');
    await writeFile(path, content, 'utf8');
    return path;
  };

  it('reads a file as UTF-8', async () => {
    const path = await fileWith('[{"Sid":"café"}]');

    await expect(readInput(path)).resolves.toBe('[{"Sid":"café"}]');
  });

  it('turns a file that cannot be read into a usage error that names it', async () => {
    const missing = join(tmpdir(), 'danube-no-such-dir', 'policy.json');

    const err = await readInput(missing).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toContain(missing);
    expect((err as Error).message).toMatch(/^Cannot read /);
  });

  it('names the path once, and says what is wrong with it', async () => {
    const missing = join(tmpdir(), 'danube-no-such-dir', 'policy.json');

    const err = await readInput(missing).catch((e: unknown) => e);

    expect((err as Error).message).toBe(`Cannot read ${missing}: ENOENT: no such file or directory`);
  });

  it('keeps what Node says when it does not end with the path', async () => {
    dir = await mkdtemp(join(tmpdir(), 'danube-read-input-'));

    const err = await readInput(dir).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toContain('EISDIR');
  });

  it('refuses an empty path instead of trying to open it', async () => {
    await expect(readInput('')).rejects.toThrow(UsageError);
    await expect(readInput('   ')).rejects.toThrow(/needs a path/);
  });

  it('reads the standard input for a lone dash', async () => {
    pipeIntoStdin(Buffer.from('[{"Effect":'), Buffer.from('"Allow"}]'));

    await expect(readInput(STDIN_SOURCE)).resolves.toBe('[{"Effect":"Allow"}]');
  });

  it('says what it is waiting for when the standard input is a terminal', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    typeIntoStdin(Buffer.from('[]'));

    await expect(readInput(STDIN_SOURCE)).resolves.toBe('[]');

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Ctrl-D'));
  });

  it('says nothing about it when the standard input is piped', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    pipeIntoStdin(Buffer.from('[]'));

    await readInput(STDIN_SOURCE);

    expect(stderr).not.toHaveBeenCalled();
  });

  it('does not break a multi-byte character that arrives split across two chunks', async () => {
    // "é" is 0xC3 0xA9: decoding each chunk on its own would yield two U+FFFD.
    pipeIntoStdin(Buffer.from([0xc3]), Buffer.from([0xa9]));

    await expect(readInput(STDIN_SOURCE)).resolves.toBe('é');
  });

  it('uses the dash as the standard input only when it stands alone', async () => {
    const err = await readInput('-policy.json').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UsageError);
  });
});
