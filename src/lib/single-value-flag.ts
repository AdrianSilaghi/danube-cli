import type { Command } from 'commander';
import { UsageError } from './errors.js';

/** What a single-valued option holds once it has been given more than once. */
class RepeatedFlag {
  constructor(readonly flag: string) {}
}

/**
 * The parser of an option that takes ONE value, for `.option(flags, text, parser)`.
 *
 * Commander keeps the last of a repeated option, so `--scope none --scope team`
 * would make a team key and say nothing. A repeat is remembered here and refused
 * by `refuseRepeatedFlags`, which every command using this must register.
 *
 * It is not refused here, while Commander is still parsing: the root hook that
 * switches `--json` on has not run yet, so the refusal would reach a script as
 * plain text instead of the envelope it was promised.
 */
export function singleValue(flag: string): (value: string, previous?: string) => string {
  return (value, previous) => (previous === undefined ? value : (new RepeatedFlag(flag) as unknown as string));
}

/**
 * A `preAction` hook that refuses any option given more than once. It runs after
 * the root's hook, so JSON mode is on by then. Name the flag, never what it was
 * given: a flag can carry anything, a statement list included.
 */
export function refuseRepeatedFlags(_command: Command, actionCommand: Command): void {
  for (const value of Object.values(actionCommand.opts())) {
    if (value instanceof RepeatedFlag) {
      throw new UsageError(`${value.flag} was given more than once; give it once.`);
    }
  }
}
