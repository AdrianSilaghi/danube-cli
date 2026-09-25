import { buildProgram } from './program.js';
import { handleError } from './lib/handle-error.js';
import { isJsonMode } from './lib/json-mode.js';
import { findUnknownCommand, formatUnknownCommand, wantsJsonOutput } from './lib/command-resolution.js';
import { autoUpdateIfEnabled, prepareUpdateNotice } from './lib/update-notice.js';

const program = buildProgram();
const argv = process.argv.slice(2);

// Checked before anything runs and printed as the process exits, so the notice
// reaches every interactive run: a successful command, a failed one,
// `--help`, an unknown command and a bare `danube`. Automation never sees it —
// the gates (JSON mode, redirected stderr, CI, DANUBE_NO_UPDATE_CHECK) live in
// prepareUpdateNotice and checkForUpdate.
//
// Awaited rather than overlapped with the command on purpose: `--help`,
// `--version` and a bare `danube` exit synchronously inside Commander, before
// an overlapped check could ever land. The wait is a local file read, plus at
// most one second of registry time once every six hours.
const updateNotice = await prepareUpdateNotice(argv);
process.on('exit', () => updateNotice.print());

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
const unknown = findUnknownCommand(program, argv);
if (unknown) {
  const { lines, exitCode, stream } = formatUnknownCommand(unknown, wantsJsonOutput(argv));
  const write = stream === 'stdout' ? console.log : console.error;
  for (const line of lines) write(line);
  process.exit(exitCode);
}

program.parseAsync()
  // Auto-update (opt-in, same-major only) runs only after a command succeeded:
  // installing underneath a failing command would muddy what went wrong.
  .then(() => autoUpdateIfEnabled(updateNotice))
  .catch((err) => handleError(err));
