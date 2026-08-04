import type { Command } from 'commander';

/**
 * An unrecognised command token, located in the command tree.
 */
export interface UnknownCommandReport {
  /** The token that matched no command. */
  token: string;
  /** Command path it was found under — `[]` at the root, `['rapids']` under a group. */
  parentPath: string[];
  /** Sibling command names at that level, for the caller to suggest. */
  known: string[];
}

interface OptionLookup {
  known: boolean;
  takesValue: boolean;
}

/**
 * Look a flag up across the current command and its ancestors.
 *
 * Options are inherited: `--project` is declared once on the root and accepted
 * at any depth, so a lookup that only consulted the innermost command would
 * treat it as unknown.
 */
function lookupOption(stack: readonly Command[], flag: string): OptionLookup {
  for (const cmd of stack) {
    for (const opt of cmd.options) {
      if (opt.short === flag || opt.long === flag) {
        // `required`/`optional` describe the option's ARGUMENT, not the option
        // itself: both mean it consumes the following token.
        return { known: true, takesValue: Boolean(opt.required || opt.optional) };
      }
    }
  }

  // Commander adds these implicitly, so they never appear in `.options`.
  if (flag === '-h' || flag === '--help' || flag === '-V' || flag === '--version') {
    return { known: true, takesValue: false };
  }

  return { known: false, takesValue: false };
}

function subcommandNames(cmd: Command): string[] {
  return cmd.commands.map((c) => c.name()).sort();
}

function findSubcommand(cmd: Command, token: string): Command | undefined {
  return cmd.commands.find((c) => c.name() === token || c.aliases().includes(token));
}

/**
 * Walk argv against the command tree and return the first token that names no
 * command, or `null` if the invocation resolves.
 *
 * This runs BEFORE Commander parses, because Commander's own handling is
 * inconsistent for the case that matters most to an automated caller:
 * `danube rapids probe` exits 1, while `danube rapids probe --help` prints the
 * parent's help and exits 0 — `--help` is consumed as a flag before the unknown
 * command is ever considered. An agent reads that 0 as "the command exists".
 *
 * The walk is deliberately conservative: anything it cannot resolve with
 * certainty it hands back to Commander, which reports options and arguments
 * with its own suggestions. Returning `null` costs a less specific error;
 * returning a wrong report costs a false failure on a valid command line.
 */
export function findUnknownCommand(root: Command, argv: readonly string[]): UnknownCommandReport | null {
  // Innermost command first, so a subcommand's option shadows an inherited one.
  const stack: Command[] = [root];
  const path: string[] = [];
  let cmd = root;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    // Everything after `--` is an operand by definition.
    if (token === '--') return null;

    if (token.startsWith('-') && token.length > 1) {
      const flag = token.split('=')[0]!;
      const option = lookupOption(stack, flag);

      // An unrecognised option is Commander's to report. Guessing whether it
      // consumes the next token is exactly how `danube --project 4 registry
      // context` came to be rejected as "unknown command '4'".
      if (!option.known) return null;

      if (option.takesValue && !token.includes('=')) i++;
      continue;
    }

    // A leaf command's positionals are its arguments, not command names.
    if (cmd.commands.length === 0) return null;

    // A command that takes its own arguments AND has subcommands cannot be
    // told apart here; leave it to Commander rather than risk a false report.
    if (cmd.registeredArguments.length > 0) return null;

    // Commander's built-in help command is not registered in `.commands`.
    if (token === 'help') return null;

    const next = findSubcommand(cmd, token);
    if (!next) {
      return { token, parentPath: [...path], known: subcommandNames(cmd) };
    }

    cmd = next;
    stack.unshift(next);
    path.push(next.name());
  }

  return null;
}

/**
 * Whether `--json` was requested, decided from argv alone.
 *
 * The parser-level check runs before Commander's `preAction` hook — which is
 * what sets JSON mode — so an unknown command reported from here would
 * otherwise always print prose, even under `--json`.
 */
export function wantsJsonOutput(argv: readonly string[]): boolean {
  for (const token of argv) {
    if (token === '--') return false;
    if (token === '--json') return true;
  }

  return false;
}

export interface UnknownCommandOutput {
  lines: string[];
  exitCode: number;
  /** JSON goes to stdout with every other envelope; prose goes to stderr. */
  stream: 'stdout' | 'stderr';
}

/**
 * Render an unknown-command report.
 *
 * Exit code 2, not 1: the README defines 2 as a usage error — the command line
 * was wrong and is not worth retrying unchanged — while 1 is a generic or API
 * error, which an agent may reasonably retry. An unknown command never
 * succeeds on a second attempt.
 */
export function formatUnknownCommand(report: UnknownCommandReport, json: boolean): UnknownCommandOutput {
  const parent = ['danube', ...report.parentPath].join(' ');
  const message = `unknown command '${report.token}' for '${parent}'`;

  if (json) {
    return {
      lines: [JSON.stringify({
        success: false,
        data: null,
        error: {
          code: 'unknown_command',
          message,
          command: report.token,
          parent: report.parentPath.join(' '),
          retryable: false,
        },
        meta: { known_commands: report.known },
      }, null, 2)],
      exitCode: 2,
      stream: 'stdout',
    };
  }

  return {
    lines: [
      `error: unknown command '${report.token}'`,
      `Available under '${parent}': ${report.known.join(', ')}`,
      `Run '${parent} --help' for details.`,
    ],
    exitCode: 2,
    stream: 'stderr',
  };
}
