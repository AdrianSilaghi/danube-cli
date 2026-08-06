import { buildProgram } from './program.js';
import { handleError } from './lib/handle-error.js';
import { checkForUpdate, printAutoUpdateNotice, printUpdateNotification } from './lib/version.js';
import { readConfig } from './lib/config.js';
import { performUpgrade } from './lib/upgrade.js';
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
  const { lines, exitCode, stream } = formatUnknownCommand(unknown, wantsJsonOutput(argv));
  const write = stream === 'stdout' ? console.log : console.error;
  for (const line of lines) write(line);
  process.exit(exitCode);
}

program.parseAsync()
  .then(async () => {
    // Runs AFTER the command, and only for an interactive human. The four
    // gates (JSON mode, TTY, CI, opt-out) are why automation never inherits a
    // version change it did not ask for — `checkForUpdate` enforces the last
    // two itself.
    if (isJsonMode() || !process.stderr.isTTY) return;

    const result = await checkForUpdate();
    if (!result?.updateAvailable) return;

    // Auto-update is opt-in AND same-major only. A major bump renames codes
    // and changes semantics — installing that underneath someone mid-session
    // is the failure this CLI exists to help people avoid, so it is always
    // announced and never applied.
    if (!result.isMajor) {
      const config = await readConfig().catch(() => null);

      if (config?.autoUpdate === true) {
        const outcome = await performUpgrade(result.current, result.latest);

        // A refusal (version manager, unwritable prefix) falls through to the
        // ordinary notice rather than nagging about plumbing every run.
        if (outcome.ok) {
          printAutoUpdateNotice(outcome.from, outcome.to);

          return;
        }
      }
    }

    printUpdateNotification(result.current, result.latest, result.isMajor);
  })
  .catch((err) => handleError(err));
