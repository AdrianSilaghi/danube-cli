import { createReadStream } from 'node:fs';
import chalk from 'chalk';
import { UsageError } from './errors.js';

/** `--file -` reads the standard input, as most Unix tools do. */
export const STDIN_SOURCE = '-';

/**
 * The most a policy input can be. A bucket takes at most 20 KB of custom
 * statements, so anything near this is not one: it is the wrong file, or the
 * wrong pipe, and is refused without reading the rest of it.
 */
export const MAX_INPUT_BYTES = 256 * 1024;

const describe = (source: string): string => (source === STDIN_SOURCE ? 'the standard input' : source);

/** Every byte, or a usage error as soon as there are more than the limit allows. */
async function collect(stream: AsyncIterable<Buffer | string>, source: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;

    if (size > MAX_INPUT_BYTES) {
      throw new UsageError(
        `${describe(source)} is larger than 256 KiB; a bucket takes at most 20 KB of custom statements.`,
      );
    }

    chunks.push(bytes);
  }

  return Buffer.concat(chunks);
}

/**
 * UTF-8 or nothing. `Buffer#toString('utf8')` quietly replaces every byte it
 * cannot read with U+FFFD, so a Windows-1252 file that said "secret-é/*" went
 * out as "secret-" and a replacement character, and a Deny on it then matched
 * nothing — while the command reported success. A leading byte order mark is
 * dropped by the decoder, which is what a UTF-8 editor on Windows puts there.
 */
function decode(bytes: Buffer, source: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new UsageError(`${describe(source)} is not valid UTF-8; save it as UTF-8.`);
  }
}

async function readFileBytes(path: string): Promise<Buffer> {
  try {
    return await collect(createReadStream(path), path);
  } catch (err) {
    if (err instanceof UsageError) throw err;

    // Always a NodeJS.ErrnoException: that is all a read stream fails with. Its
    // message ends with the path again (", open '/x/y'"), which is already named.
    const reason = (err as NodeJS.ErrnoException).message.replace(/, open '.*'$/, '');
    throw new UsageError(`Cannot read ${path}: ${reason}`);
  }
}

async function readStdinBytes(): Promise<Buffer> {
  // Nothing is piped in: say what the terminal is waiting for rather than look hung.
  if (process.stdin.isTTY) {
    const finish = process.platform === 'win32' ? 'Ctrl-Z then Enter' : 'Ctrl-D';
    console.error(chalk.dim(`Reading the standard input; finish with ${finish}.`));
  }

  return collect(process.stdin, STDIN_SOURCE);
}

/**
 * The text of a file, or of the standard input for `-`: UTF-8 only, and not more
 * than MAX_INPUT_BYTES.
 *
 * A file that cannot be read is a usage error — the path is the caller's to
 * fix — and names the path, so a script log says which file it was.
 */
export async function readInput(source: string): Promise<string> {
  if (source !== STDIN_SOURCE && source.trim() === '') {
    throw new UsageError('--file needs a path, or - for the standard input.');
  }

  const bytes = source === STDIN_SOURCE ? await readStdinBytes() : await readFileBytes(source);

  return decode(bytes, source);
}
