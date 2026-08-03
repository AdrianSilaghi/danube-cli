import chalk from 'chalk';
import { NotAuthenticatedError, NotLinkedError, ApiError, MissingFlagsError, ConfirmationRequiredError, ResourceNotFoundError, UsageError } from './errors.js';
import { isJsonMode, jsonError } from './json-mode.js';

export function handleError(err: unknown): never {
  // Ctrl+C inside an @inquirer prompt
  if (err instanceof Error && err.name === 'ExitPromptError') {
    if (isJsonMode()) jsonError({ code: 'cancelled', message: 'Cancelled.' });
    else console.log('Cancelled.');
    process.exit(130);
  }

  if (isJsonMode()) {
    if (err instanceof NotAuthenticatedError) {
      jsonError({ code: 'not_authenticated', message: err.message });
      process.exit(3);
    }
    if (err instanceof NotLinkedError) {
      jsonError({ code: 'not_linked', message: err.message });
      process.exit(1);
    }
    if (err instanceof MissingFlagsError) {
      jsonError({ code: 'missing_required_flag', message: err.message, flags: err.flags });
      process.exit(2);
    }
    if (err instanceof UsageError) {
      // Same exit code as a missing flag: both mean "the command was wrong",
      // which is never worth retrying unchanged.
      jsonError({ code: 'usage_error', message: err.message });
      process.exit(2);
    }
    if (err instanceof ConfirmationRequiredError) {
      jsonError({ code: 'confirmation_required', message: err.message });
      process.exit(5);
    }
    if (err instanceof ResourceNotFoundError) {
      jsonError({ code: 'not_found', message: err.message });
      process.exit(4);
    }
    if (err instanceof ApiError) {
      jsonError({
        // The top-level shape is a contract existing scripts parse — `cause`
        // is additive, so nothing reading `code`/`status` breaks.
        code: 'api_error',
        message: err.message,
        status: err.statusCode,
        ...(err.errors && { errors: err.errors }),
        // What the backend actually said: the failure code, the resource it
        // concerns, and whether a retry can help. Without this, every API
        // failure looks equally retryable from the outside.
        ...(err.cause && { cause: err.cause }),
      });
      process.exit(err.statusCode === 404 ? 4 : 1);
    }
    jsonError({ code: 'error', message: err instanceof Error ? err.message : 'An unexpected error occurred.' });
    process.exit(1);
  }

  if (err instanceof NotAuthenticatedError) {
    console.error(chalk.red(err.message));
    process.exit(3);
  }
  if (err instanceof NotLinkedError) {
    console.error(chalk.red(err.message));
    process.exit(1);
  }
  if (err instanceof MissingFlagsError) {
    console.error(chalk.red(err.message));
    process.exit(2);
  }
  if (err instanceof UsageError) {
    console.error(chalk.red(err.message));
    process.exit(2);
  }
  if (err instanceof ConfirmationRequiredError) {
    console.error(chalk.red(err.message));
    process.exit(5);
  }
  if (err instanceof ResourceNotFoundError) {
    console.error(chalk.red(err.message));
    process.exit(4);
  }
  if (err instanceof ApiError) {
    console.error(chalk.red(`API Error (${err.statusCode}): ${err.message}`));
    if (err.cause) {
      console.error(chalk.dim(`  code: ${err.cause.code}`));
      if (err.cause.resource?.name) {
        console.error(chalk.dim(`  resource: ${err.cause.resource.kind ?? 'resource'}/${err.cause.resource.name}`));
      }
      if (err.cause.retryable !== undefined) {
        console.error(chalk.dim(`  retryable: ${err.cause.retryable ? 'yes' : 'no'}`));
      }
    }
    if (err.errors) {
      for (const [field, messages] of Object.entries(err.errors)) {
        for (const msg of messages) {
          console.error(chalk.red(`  ${field}: ${msg}`));
        }
      }
    }
    process.exit(err.statusCode === 404 ? 4 : 1);
  }
  console.error(chalk.red(err instanceof Error ? err.message : 'An unexpected error occurred.'));
  process.exit(1);
}
