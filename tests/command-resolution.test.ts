import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { buildProgram } from '../src/program.js';
import { findUnknownCommand, formatUnknownCommand, wantsJsonOutput } from '../src/lib/command-resolution.js';

// The REAL tree, not a copy — a mock would go stale the first time a command
// is added, which is precisely the class of bug these tests exist to catch.
const program = buildProgram();

const resolve = (line: string) => findUnknownCommand(program, line.split(' ').filter(Boolean));

describe('option values are never mistaken for commands', () => {
  it('accepts a global option that takes a separate value before the command', () => {
    // The reported regression: `--project 4 registry context` was rejected as
    // "unknown command '4'" because the pre-parse scan took the first non-flag
    // token without knowing `--project` had consumed it.
    expect(resolve('--project 4 registry context')).toBeNull();
  });

  it('accepts the same option in --flag=value form', () => {
    expect(resolve('--project=4 registry context')).toBeNull();
  });

  it('accepts a global option after the command', () => {
    expect(resolve('registry context --project 4')).toBeNull();
  });

  it('does not swallow the command after a boolean flag', () => {
    expect(resolve('--json nonsense')?.token).toBe('nonsense');
  });

  it('still reports the real unknown command when an option precedes it', () => {
    const report = resolve('--project 4 nonsense');
    expect(report?.token).toBe('nonsense');
    expect(report?.parentPath).toEqual([]);
  });

  it('accepts --team, the compatibility alias, which also takes a value', () => {
    expect(resolve('--team 7 whoami')).toBeNull();
  });

  it('hands an unrecognised option back to Commander rather than guessing', () => {
    // We cannot know whether `--nope` consumes `rapids`. Commander reports the
    // bad option with its own suggestions; a guess here risks a false failure
    // on a valid command line.
    expect(resolve('--nope rapids ls')).toBeNull();
  });

  it('treats everything after -- as operands', () => {
    expect(resolve('rapids logs app -- nonsense')).toBeNull();
  });
});

describe('unknown commands are reported at every depth', () => {
  it('reports an unknown top-level command', () => {
    const report = resolve('nonsense');
    expect(report?.token).toBe('nonsense');
    expect(report?.known).toContain('rapids');
  });

  it('reports an unknown subcommand under its parent', () => {
    // Deliberately a token that will never become a command. `rapids probe`
    // used to sit here and started passing the day probe shipped — which is
    // precisely why these tests run against the real tree.
    const report = resolve('rapids no-such-subcommand');
    expect(report?.token).toBe('no-such-subcommand');
    expect(report?.parentPath).toEqual(['rapids']);
    expect(report?.known).toContain('diagnose');
  });

  it('reports it identically when --help is appended', () => {
    // The reported inconsistency: Commander consumes `--help` as a flag of the
    // command it has resolved so far, prints the PARENT's help and exits 0.
    expect(resolve('rapids no-such-subcommand --help')).toEqual(resolve('rapids no-such-subcommand'));
  });

  it('reports an unknown top-level command with --help the same way', () => {
    expect(resolve('no-such-command --help')).toEqual(resolve('no-such-command'));
  });

  it('reports an unknown command three levels down', () => {
    const report = resolve('storage buckets nonsense');
    expect(report?.parentPath).toEqual(['storage', 'buckets']);
  });
});

describe('valid invocations resolve', () => {
  const valid = [
    'whoami',
    'whoami --help',
    '--help',
    '--version',
    'help',
    'rapids ls',
    'rapids diagnose --help',
    'rapids get my-api',
    'rapids show my-api',       // alias of `get`
    'rapids delete my-api',     // alias of `rm`
    'registry context',
    'registry verify-push safi4/app:1',
    'storage buckets ls',
    'project select',
    'rapids probe my-api',
    'rapids preflight --image cr.danubedata.ro/ns/app:v1',
    'operations wait op-1 --timeout 30m',
    'operations inspect op-1',
  ];

  for (const line of valid) {
    it(`accepts \`danube ${line}\``, () => {
      expect(resolve(line)).toBeNull();
    });
  }

  it('treats a leaf command\'s positional as an argument, not a command', () => {
    // `my-api` is a container name. Reporting it as an unknown command would
    // break every command that takes a resource name.
    expect(resolve('rapids logs my-api')).toBeNull();
  });

  it('declines to judge a command that takes its own arguments', () => {
    const parent = new Command('p').argument('<thing>').addCommand(new Command('child'));
    const root = new Command('root').addCommand(parent);

    expect(findUnknownCommand(root, ['p', 'whatever'])).toBeNull();
  });
});

describe('output format', () => {
  const report = { token: 'probe', parentPath: ['rapids'], known: ['diagnose', 'logs'] };

  it('emits the standard envelope under --json', () => {
    const { lines, exitCode, stream } = formatUnknownCommand(report, true);

    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!);
    expect(payload.success).toBe(false);
    expect(payload.data).toBeNull();
    expect(payload.error.code).toBe('unknown_command');
    expect(payload.error.command).toBe('probe');
    expect(payload.error.parent).toBe('rapids');
    // An unknown command never succeeds on a second attempt.
    expect(payload.error.retryable).toBe(false);
    expect(payload.meta.known_commands).toEqual(['diagnose', 'logs']);
    // Same destination as every other envelope, so one capture finds it.
    expect(stream).toBe('stdout');
    expect(exitCode).toBe(2);
  });

  it('names the parent and its commands in prose', () => {
    const { lines, exitCode } = formatUnknownCommand(report, false);

    expect(lines[0]).toContain("unknown command 'probe'");
    expect(lines[1]).toContain('danube rapids');
    expect(lines[1]).toContain('diagnose');
    expect(exitCode).toBe(2);
  });

  it('exits 2, the documented usage-error code, not 1', () => {
    // 1 is "generic or API error", which an agent may reasonably retry.
    expect(formatUnknownCommand(report, true).exitCode).toBe(2);
    expect(formatUnknownCommand(report, false).exitCode).toBe(2);
  });
});

describe('json detection before parse', () => {
  it('detects --json anywhere in the arguments', () => {
    expect(wantsJsonOutput(['rapids', 'ls', '--json'])).toBe(true);
    expect(wantsJsonOutput(['--json', 'rapids', 'ls'])).toBe(true);
  });

  it('ignores --json after the operand terminator', () => {
    expect(wantsJsonOutput(['rapids', 'logs', 'app', '--', '--json'])).toBe(false);
  });

  it('is false when absent', () => {
    expect(wantsJsonOutput(['rapids', 'ls'])).toBe(false);
  });
});
