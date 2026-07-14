import { confirm } from '@inquirer/prompts';
import { isJsonMode } from './json-mode.js';
import { MissingFlagsError, ConfirmationRequiredError } from './errors.js';

export function canPrompt(): boolean {
  return !isJsonMode() && process.stdin.isTTY === true;
}

/** Return the flag value, or prompt for it — failing fast when non-interactive. */
export async function promptOr<T>(flag: string, value: T | undefined, prompt: () => Promise<T>): Promise<T> {
  if (value !== undefined) return value;
  if (!canPrompt()) throw new MissingFlagsError([flag]);
  return prompt();
}

/** True to proceed. Throws ConfirmationRequiredError when non-interactive and not forced. */
export async function confirmDestruction(what: string, message: string, force: boolean | undefined): Promise<boolean> {
  if (force) return true;
  if (!canPrompt()) throw new ConfirmationRequiredError(what);
  return confirm({ message, default: false });
}
