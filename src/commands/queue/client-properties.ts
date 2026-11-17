import { Command } from 'commander';
import chalk from 'chalk';
import { link, lstat, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, basename, join } from 'node:path';
import { ApiClient } from '../../lib/api-client.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import { UsageError } from '../../lib/errors.js';
import { resolveQueue } from './shared.js';

/** Everything that can be known about the destination before spending an audited credential read. */
async function checkDestination(file: string, force: boolean | undefined): Promise<void> {
  const existing = await lstat(file).catch(() => null);
  if (existing?.isDirectory()) throw new UsageError(`${file} is a directory. Give -o a file name.`);
  if (existing && !force) {
    throw new UsageError(`${file} already exists. Use --force to overwrite it, or -o to pick another file.`);
  }
  const parent = await stat(dirname(file)).catch(() => null);
  if (!parent?.isDirectory()) throw new UsageError(`The directory ${dirname(file)} does not exist.`);
}

/**
 * Temp file in the same directory (exclusive, 0600), then put it in place: a failed
 * write never loses the old file, and a symlink at the target is replaced, not followed.
 * Without --force the final step is link(), which fails if the target appeared meanwhile.
 */
async function writeSecretFile(file: string, content: string, force: boolean | undefined): Promise<void> {
  const temp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(temp, content, { mode: 0o600, flag: 'wx' });
  try {
    if (force) {
      await rename(temp, file);
      return;
    }
    await link(temp, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new UsageError(`${file} appeared while writing. Run again, or pick another file with -o.`);
    }
    throw err;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

/** Writes the file with mode 600: it holds the password. Never printed unless `-o -`. */
export const clientPropertiesCommand = new Command('client-properties')
  .description('Write the Kafka client properties file (includes credentials; mode 600)')
  .argument('<queue>', 'Queue name or ID')
  .option('-o, --output <file>', 'File to write (default kafka-<name>-client.properties); "-" prints to stdout')
  .option('-f, --force', 'Overwrite an existing file')
  .action(async (nameOrId: string, opts: { output?: string; force?: boolean }) => {
    if (opts.output === '-' && isJsonMode()) {
      throw new UsageError('-o - prints a properties file, which is not JSON. Drop --json, or write to a file.');
    }

    const api = await ApiClient.create();
    const queue = await resolveQueue(api, nameOrId, true);
    const file = opts.output === '-' ? null : (opts.output ?? `kafka-${queue.name}-client.properties`);
    if (file) await checkDestination(file, opts.force);

    const content = await api.getText(`/api/v1/queue/${queue.id}/client-properties`);

    if (!file) {
      process.stdout.write(content);
      return;
    }
    await writeSecretFile(file, content, opts.force);

    if (isJsonMode()) {
      jsonOutput({ file });
      return;
    }
    console.log(chalk.green(`Client properties written to ${file} (mode 600).`));
    console.log(chalk.dim('It contains your password: keep it out of version control.'));
  });
