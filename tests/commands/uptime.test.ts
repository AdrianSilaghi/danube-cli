import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { buildProgram } from '../../src/program.js';

// The REAL tree, so a command that stops being registered fails here rather
// than at a customer's terminal.
const program = buildProgram();

function group(name: string): Command {
  const found = program.commands.find(c => c.name() === name);
  expect(found, `command group "${name}" is not registered`).toBeDefined();
  return found!;
}

function sub(parent: Command, name: string): Command {
  const found = parent.commands.find(c => c.name() === name);
  expect(found, `"${parent.name()} ${name}" is not registered`).toBeDefined();
  return found!;
}

describe('uptime command group', () => {
  const uptime = group('uptime');

  it('exposes the full CRUD surface', () => {
    for (const verb of ['ls', 'create', 'get', 'update', 'rm']) {
      expect(sub(uptime, verb).name()).toBe(verb);
    }
  });

  it('exposes the operational verbs', () => {
    for (const verb of ['pause', 'resume', 'incidents', 'diagnose']) {
      expect(sub(uptime, verb).name()).toBe(verb);
    }
  });

  it('aliases rm to delete', () => {
    expect(sub(uptime, 'rm').aliases()).toContain('delete');
  });

  it('answers to the uptime-checks alias, matching the API path', () => {
    expect(uptime.aliases()).toContain('uptime-checks');
  });

  /**
   * Pausing is a toggle server-side, so the CLI splits it into two verbs
   * that each refuse to run in the wrong direction — `pause` on an already
   * paused check must not silently resume it.
   */
  it('separates pause from resume rather than exposing a raw toggle', () => {
    expect(uptime.commands.map(c => c.name())).not.toContain('toggle');
    expect(uptime.commands.map(c => c.name())).toEqual(
      expect.arrayContaining(['pause', 'resume']),
    );
  });

  it('requires a target for every check-scoped verb', () => {
    for (const verb of ['get', 'update', 'rm', 'pause', 'resume', 'incidents', 'diagnose']) {
      const args = sub(uptime, verb).registeredArguments;
      expect(args.length, `"${verb}" should take a name-or-id argument`).toBeGreaterThan(0);
      expect(args[0]!.required).toBe(true);
    }
  });

  it('does not take a target for the list and create verbs', () => {
    expect(sub(uptime, 'ls').registeredArguments).toHaveLength(0);
    expect(sub(uptime, 'create').registeredArguments).toHaveLength(0);
  });

  it('offers the create flags an agent needs to run non-interactively', () => {
    const flags = sub(uptime, 'create').options.map(o => o.long);
    expect(flags).toEqual(expect.arrayContaining(['--name', '--url', '--interval', '--method']));
  });

  it('lets update change the target URL and the schedule', () => {
    const flags = sub(uptime, 'update').options.map(o => o.long);
    expect(flags).toEqual(expect.arrayContaining(['--name', '--url', '--interval']));
  });

  /**
   * `enabled` is deliberately absent from update: pausing closes any open
   * incident, which a field assignment would not convey.
   */
  it('does not let update flip the enabled flag', () => {
    const flags = sub(uptime, 'update').options.map(o => o.long);
    expect(flags).not.toContain('--enabled');
  });

  it('gives rm a non-interactive escape hatch', () => {
    const flags = sub(uptime, 'rm').options.map(o => o.long);
    expect(flags).toEqual(expect.arrayContaining(['--force', '--yes']));
  });
});
