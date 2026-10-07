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
    /**
     * The envelope's top-level `meta`, e.g. `{active_run_id}` on a 409 from
     * `POST .../runs`. Additive, like `cause`: existing readers of `code` and
     * `status` are unaffected by a field they never look at.
     */
    public meta?: Record<string, unknown>,
    /**
     * How long the server asked the client to wait before trying again — the
     * `Retry-After` header, in whole seconds. Absent when the server did not
     * send one, or sent a form this client does not read (an HTTP date).
     */
    public retryAfterSeconds?: number,
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
  /**
   * `promptable: false` is for a command that never asks for what is missing, so
   * "in non-interactive mode" would be a reason that is not one.
   */
  constructor(public flags: string[], options: { promptable?: boolean } = {}) {
    const where = options.promptable === false ? '' : ' in non-interactive mode';
    super(`Missing required flag${flags.length > 1 ? 's' : ''}${where}: ${flags.join(', ')}`);
    this.name = 'MissingFlagsError';
  }
}

export class ConfirmationRequiredError extends Error {
  /**
   * `reason` replaces "without --force in non-interactive mode" when that is not
   * why nothing can be asked: the statements of `policy set --file -` arrive on
   * the very input a question would be read from.
   */
  constructor(what: string, reason?: string) {
    super(
      reason === undefined
        ? `Refusing to proceed with ${what} without --force in non-interactive mode.`
        : `Refusing to proceed with ${what}: ${reason}`,
    );
    this.name = 'ConfirmationRequiredError';
  }
}

export class ResourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceNotFoundError';
  }
}
