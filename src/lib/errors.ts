export class NotAuthenticatedError extends Error {
  constructor() {
    super('Not authenticated. Run `danube login` first.');
    this.name = 'NotAuthenticatedError';
  }
}

export class NotLinkedError extends Error {
  constructor() {
    super('No project linked. Run `danube pages link` first.');
    this.name = 'NotLinkedError';
  }
}

/**
 * The structured failure the API reported inside its response envelope.
 *
 * Distinct from the HTTP status: a 503 says the request did not succeed, while
 * `code` says WHY and `retryable` says whether trying again can possibly help.
 * An agent that retries a non-retryable failure — a bad registry credential, a
 * missing RBAC grant — burns quota forever without making progress.
 */
export interface ApiErrorCause {
  code: string;
  message?: string;
  reason?: string | null;
  resource?: { kind?: string; name?: string } | null;
  retryable?: boolean;
  request_id?: string | null;
}

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public errors?: Record<string, string[]>,
    public cause?: ApiErrorCause,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * A malformed invocation — a conflicting selector, a non-integer id.
 *
 * Deliberately its own type with its own exit code: automation must be able to
 * tell "I called this wrong" (never retry; fix the command) apart from "the
 * platform failed" (retrying may help).
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export class MissingFlagsError extends Error {
  constructor(public flags: string[]) {
    super(`Missing required flag${flags.length > 1 ? 's' : ''} in non-interactive mode: ${flags.join(', ')}`);
    this.name = 'MissingFlagsError';
  }
}

export class ConfirmationRequiredError extends Error {
  constructor(what: string) {
    super(`Refusing to proceed with ${what} without --force in non-interactive mode.`);
    this.name = 'ConfirmationRequiredError';
  }
}

export class ResourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceNotFoundError';
  }
}
