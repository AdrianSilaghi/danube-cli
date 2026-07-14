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

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public errors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'ApiError';
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
    super(`Refusing to delete ${what} without --force in non-interactive mode.`);
    this.name = 'ConfirmationRequiredError';
  }
}
