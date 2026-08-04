import { buildProgram } from './program.js';
import { handleError } from './lib/handle-error.js';
import { checkForUpdate, printUpdateNotification } from './lib/version.js';
import { isJsonMode } from './lib/json-mode.js';
import { findUnknownCommand, formatUnknownCommand, wantsJsonOutput } from './lib/command-resolution.js';

const program = buildProgram();

// Graceful SIGINT fallback — clean exit when Ctrl+C is pressed outside polling loops
process.on('SIGINT', () => {
  if (!isJsonMode()) console.log('');
  process.exit(130);
});

process.on('unhandledRejection', (err) => handleError(err));

// Resolve the command path before Commander parses. Commander consumes
// `--help` as a flag of whatever command it has resolved SO FAR, so
// `danube rapids probe --help` printed the `rapids` help and exited 0 while
// `danube rapids probe` exited 1 — the same non-existent command reported two
// different ways depending on a flag.
const argv = process.argv.slice(2);
const unknown = findUnknownCommand(program, argv);
if (unknown) {
  const { lines, exitCode } = formatUnknownCommand(unknown, wantsJsonOutput(argv));
  for (const line of lines) console.error(line);
  process.exit(exitCode);
}

program.parseAsync()
  .then(async () => {
    if (!isJsonMode() && process.stderr.isTTY) {
      const result = await checkForUpdate();
      if (result?.updateAvailable) {
        printUpdateNotification(result.current, result.latest);
      }
    }
  })
  .catch((err) => handleError(err));
