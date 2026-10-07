import { readFile } from 'node:fs/promises';
import chalk from 'chalk';
import { UsageError } from './errors.js';

/** `--file -` reads the standard input, as most Unix tools do. */
export const STDIN_SOURCE = '-';

async function readStdin(): Promise<string> {
  // Nothing is piped in: say what the terminal is waiting for rather than look hung.
  if (process.stdin.isTTY) console.error(chalk.dim('Reading the standard input; finish with Ctrl-D.'));

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  // Joined before decoding: a character can be split across two chunks.
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The text of a file, or of the standard input for `-`.
 *
 * A file that cannot be read is a usage error — the path is the caller's to
 * fix — and names the path, so a script log says which file it was.
 */
export async function readInput(source: string): Promise<string> {
  if (source === STDIN_SOURCE) return readStdin();

  if (source.trim() === '') {
    throw new UsageError('--file needs a path, or - for the standard input.');
  }

  try {
    return await readFile(source, 'utf8');
  } catch (err) {
    // Always a NodeJS.ErrnoException: that is all readFile rejects with. Its
    // message ends with the path again (", open '/x/y'"), which is already named.
    const reason = (err as NodeJS.ErrnoException).message.replace(/, open '.*'$/, '');
    throw new UsageError(`Cannot read ${source}: ${reason}`);
  }
}
