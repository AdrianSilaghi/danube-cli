import { Command } from 'commander';
import chalk from 'chalk';
import { chmod, writeFile } from 'node:fs/promises';
import { ApiClient } from '../../lib/api-client.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import { UsageError } from '../../lib/errors.js';
import { resolveQueue } from './shared.js';

/** Writes the file with mode 600: it holds the password. Never printed unless `-o -`. */
export const clientPropertiesCommand = new Command('client-properties')
  .description('Write the Kafka client properties file (includes credentials; mode 600)')
  .argument('<queue>', 'Queue name or ID')
  .option('-o, --output <file>', 'File to write (default kafka-<name>-client.properties); "-" prints to stdout')
  .option('-f, --force', 'Overwrite an existing file')
  .action(async (nameOrId: string, opts: { output?: string; force?: boolean }) => {
    const api = await ApiClient.create();
    const queue = await resolveQueue(api, nameOrId);
    const content = await api.getText(`/api/v1/queue/${queue.id}/client-properties`);

    if (opts.output === '-') {
      process.stdout.write(content);
      return;
    }

    const file = opts.output ?? `kafka-${queue.name}-client.properties`;
    try {
      // 'wx' fails if the file exists, so a credentials file is never clobbered by accident.
      await writeFile(file, content, { mode: 0o600, flag: opts.force ? 'w' : 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new UsageError(`${file} already exists. Use --force to overwrite it, or -o to pick another file.`);
      }
      throw err;
    }
    // 'w' keeps the mode of a file that already existed.
    await chmod(file, 0o600);

    if (isJsonMode()) {
      jsonOutput({ file });
      return;
    }
    console.log(chalk.green(`Client properties written to ${file} (mode 600).`));
    console.log(chalk.dim('It contains your password: keep it out of version control.'));
  });
