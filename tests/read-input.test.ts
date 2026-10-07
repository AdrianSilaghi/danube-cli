import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { readInput, STDIN_SOURCE, MAX_INPUT_BYTES } from '../src/lib/read-input.js';
import { UsageError } from '../src/lib/errors.js';

const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

const pipeIntoStdin = (...chunks: Buffer[]): void => {
  Object.defineProperty(process, 'stdin', { value: Readable.from(chunks), configurable: true });
};

/** A terminal: stdin that nothing was piped into. */
const typeIntoStdin = (...chunks: Buffer[]): void => {
  Object.defineProperty(process, 'stdin', { value: Object.assign(Readable.from(chunks), { isTTY: true }), configurable: true });
};

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM_CHARACTER = String.fromCharCode(0xfeff);
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

describe('readInput', () => {
  let dir: string | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    Object.defineProperty(process, 'stdin', originalStdin);
    Object.defineProperty(process, 'platform', originalPlatform);
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  const fileWith = async (content: string | Buffer): Promise<string> => {
    dir = await mkdtemp(join(tmpdir(), 'danube-read-input-'));
    const path = join(dir, 'policy.json');
    await writeFile(path, content);
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

  it('uses the dash as the standard input only when it stands alone', async () => {
    const err = await readInput('-policy.json').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UsageError);
  });

  it('does not break a multi-byte character that arrives split across two chunks', async () => {
    // "é" is 0xC3 0xA9: decoding each chunk on its own would yield two replacement characters.
    pipeIntoStdin(Buffer.from([0xc3]), Buffer.from([0xa9]));

    await expect(readInput(STDIN_SOURCE)).resolves.toBe('é');
  });

  describe('what is, and is not, text', () => {
    // The same bytes, whether they come from a file or from a pipe.
    const sources: Array<[string, (content: Buffer) => Promise<string>]> = [
      ['a file', async (content) => readInput(await fileWith(content))],
      ['the standard input', async (content) => {
        pipeIntoStdin(content);
        return readInput(STDIN_SOURCE);
      }],
    ];

    describe.each(sources)('from %s', (_name, read) => {
      it('reads plain UTF-8, accents included', async () => {
        await expect(read(Buffer.from('café'))).resolves.toBe('café');
      });

      it('drops the byte order mark that a UTF-8 editor puts in front', async () => {
        const text = await read(Buffer.concat([UTF8_BOM, Buffer.from('[]')]));

        expect(text).toBe('[]');
        expect(text.startsWith(BOM_CHARACTER)).toBe(false);
      });

      it('refuses bytes that are not UTF-8 rather than quietly replacing them: a Windows-1252 é', async () => {
        // "secret-" + 0xE9 + "/*": in Windows-1252 that is "secret-é/*"; read as UTF-8 it was
        // sent as "secret-" + a replacement character, and a Deny on it then matched nothing.
        const cp1252 = Buffer.concat([Buffer.from('secret-'), Buffer.from([0xe9]), Buffer.from('/*')]);

        const attempt = read(cp1252);

        await expect(attempt).rejects.toThrow(UsageError);
        await expect(attempt).rejects.toThrow(/is not valid UTF-8; save it as UTF-8\.$/);
        await expect(attempt.catch((e: Error) => e.message)).resolves.not.toContain(REPLACEMENT_CHARACTER);
      });

      it.each([
        ['UTF-16 little endian, as PowerShell redirection writes it', [0xff, 0xfe, 0x5b, 0x00, 0x5d, 0x00]],
        ['UTF-16 big endian', [0xfe, 0xff, 0x00, 0x5b, 0x00, 0x5d]],
      ])('refuses %s', async (_label, bytes) => {
        await expect(read(Buffer.from(bytes))).rejects.toThrow(/is not valid UTF-8; save it as UTF-8\.$/);
      });

      it('refuses a bad byte wherever it is, the last one included', async () => {
        await expect(read(Buffer.concat([Buffer.from('[{"Sid":"fine"}]'), Buffer.from([0xe9])]))).rejects.toThrow(UsageError);
      });

      it('takes exactly the largest size it allows', async () => {
        const text = await read(Buffer.alloc(MAX_INPUT_BYTES, 'a'));

        expect(text).toHaveLength(MAX_INPUT_BYTES);
      });

      it('refuses anything larger, naming the limit and what a bucket takes', async () => {
        const attempt = read(Buffer.alloc(MAX_INPUT_BYTES + 1, 'a'));

        await expect(attempt).rejects.toThrow(UsageError);
        await expect(attempt).rejects.toThrow(/is larger than 256 KiB; a bucket takes at most 20 KB of custom statements\.$/);
      });
    });

    it('says which file was not UTF-8, and which was too large', async () => {
      const path = await fileWith(Buffer.from([0xe9]));

      await expect(readInput(path)).rejects.toThrow(`${path} is not valid UTF-8; save it as UTF-8.`);

      const big = await fileWith(Buffer.alloc(MAX_INPUT_BYTES + 1, 'a'));
      await expect(readInput(big)).rejects.toThrow(`${big} is larger than 256 KiB`);
    });

    it('says "the standard input" when that was not UTF-8, and when it was too large', async () => {
      pipeIntoStdin(Buffer.from([0xe9]));
      await expect(readInput(STDIN_SOURCE)).rejects.toThrow('the standard input is not valid UTF-8; save it as UTF-8.');

      pipeIntoStdin(Buffer.alloc(MAX_INPUT_BYTES + 1, 'a'));
      await expect(readInput(STDIN_SOURCE)).rejects.toThrow('the standard input is larger than 256 KiB');
    });

    it('stops reading the standard input as soon as it is over the limit, rather than taking all of it', async () => {
      const chunk = Buffer.alloc(64 * 1024, 'a');
      let pulled = 0;
      async function* endless(): AsyncGenerator<Buffer> {
        for (;;) {
          pulled++;
          yield chunk;
        }
      }
      Object.defineProperty(process, 'stdin', { value: Readable.from(endless()), configurable: true });

      await expect(readInput(STDIN_SOURCE)).rejects.toThrow(/larger than 256 KiB/);

      // 256 KiB is four chunks of 64 KiB; the fifth is the one that goes over. Readable.from may
      // read a little ahead, but it must stop long before "all" of an endless input.
      expect(pulled).toBeLessThan(20);
    });
  });

  describe('the hint when the standard input is a terminal', () => {
    it('says what it is waiting for, and how to finish', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
      typeIntoStdin(Buffer.from('[]'));

      await expect(readInput(STDIN_SOURCE)).resolves.toBe('[]');

      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Ctrl-D'));
    });

    it('says Ctrl-Z then Enter on Windows, where Ctrl-D ends nothing', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
      typeIntoStdin(Buffer.from('[]'));

      await readInput(STDIN_SOURCE);

      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Ctrl-Z then Enter'));
      expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining('Ctrl-D'));
    });

    it('says nothing about it when the standard input is piped', async () => {
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
      pipeIntoStdin(Buffer.from('[]'));

      await readInput(STDIN_SOURCE);

      expect(stderr).not.toHaveBeenCalled();
    });
  });
});
