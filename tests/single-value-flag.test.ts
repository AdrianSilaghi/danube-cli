import { describe, it, expect, afterEach } from 'vitest';
import { Command } from 'commander';
import { singleValue, refuseRepeatedFlags } from '../src/lib/single-value-flag.js';
import { UsageError } from '../src/lib/errors.js';
import { isJsonMode, setJsonMode } from '../src/lib/json-mode.js';
import { buildProgram } from '../src/program.js';

/** A command the way the storage commands are built: one single-valued flag, guarded. */
const commandSeeing = (seen: Array<string | undefined>): Command =>
  new Command('x')
    .option('--scope <scope>', 'where', singleValue('--scope'))
    .option('--other <other>', 'something else', singleValue('--other'))
    .hook('preAction', refuseRepeatedFlags)
    .action((opts: { scope?: string }) => { seen.push(opts.scope); });

describe('singleValue', () => {
  afterEach(() => setJsonMode(false));

  it('takes the value the first time', () => {
    expect(singleValue('--scope')('none')).toBe('none');
  });

  it('is what stops a repeated flag on a real command, where Commander would keep the last', async () => {
    const seen: Array<string | undefined> = [];
    const command = commandSeeing(seen);

    await command.parseAsync(['--scope', 'none'], { from: 'user' });
    await expect(command.parseAsync(['--scope', 'none', '--scope', 'team'], { from: 'user' })).rejects.toThrow(UsageError);
    await command.parseAsync([], { from: 'user' });

    // The refused run never reached the action, and does not leak into the next one.
    expect(seen).toEqual(['none', undefined]);
  });

  it('names the flag that was repeated, and not what it was given: a flag can carry anything', async () => {
    const command = commandSeeing([]);

    const attempt = command.parseAsync(['--other', '[{"Sid":"first"}]', '--other', '[{"Sid":"second"}]'], { from: 'user' });

    await expect(attempt).rejects.toThrow('--other was given more than once; give it once.');
    await expect(attempt).rejects.not.toThrow(/Sid/);
  });

  it('refuses a flag given three times as well', async () => {
    const command = commandSeeing([]);

    await expect(command.parseAsync(['--scope', 'a', '--scope', 'b', '--scope', 'c'], { from: 'user' }))
      .rejects.toThrow('--scope was given more than once');
  });

  it('lets two different flags each be given once', async () => {
    const seen: Array<string | undefined> = [];

    await commandSeeing(seen).parseAsync(['--scope', 'none', '--other', 'x'], { from: 'user' });

    expect(seen).toEqual(['none']);
  });

  it('does not touch a flag that was not repeated, or options that take no value', async () => {
    const seen: Array<string | undefined> = [];
    const command = new Command('x')
      .option('--wait', 'a switch')
      .option('--scope <scope>', 'where', singleValue('--scope'))
      .hook('preAction', refuseRepeatedFlags)
      .action((opts: { scope?: string }) => { seen.push(opts.scope); });

    await command.parseAsync(['--wait', '--wait', '--scope', 'none'], { from: 'user' });

    expect(seen).toEqual(['none']);
  });

  it('refuses the repeat only after the root has switched JSON mode on, so a script gets its envelope', async () => {
    // Refused while Commander is still parsing, it would be reported as plain text under --json:
    // the root hook that sets the mode has not run yet. The real program shows which comes first.
    const program = buildProgram();

    await expect(program.parseAsync(
      ['node', 'danube', '--json', 'storage', 'keys', 'create', '--name', 'x', '--scope', 'none', '--scope', 'team'],
    )).rejects.toThrow('--scope was given more than once; give it once.');

    expect(isJsonMode()).toBe(true);
  });
});
