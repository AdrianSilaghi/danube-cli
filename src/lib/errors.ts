export class NotAuthenticatedError extends Error {
  constructor() {
    super('Not authenticated. Run `danube login` first.');
    this.name = 'NotAuthenticatedError';
  }
}

export class NotLinkedError extends Error {
  constructor() {
    super('No project linked. Run `danube link` first.');
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
