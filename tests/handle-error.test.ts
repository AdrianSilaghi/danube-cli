import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleError } from '../src/lib/handle-error.js';
import { setJsonMode } from '../src/lib/json-mode.js';
import { NotAuthenticatedError, ApiError, MissingFlagsError, ConfirmationRequiredError, ResourceNotFoundError } from '../src/lib/errors.js';

class ExitError extends Error {
  constructor(public code: number) { super(`exit(${code})`); }
}

describe('handleError', () => {
  const originalExit = process.exit;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setJsonMode(false);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.exit = vi.fn().mockImplementation((code: number) => { throw new ExitError(code); }) as never;
  });

  afterEach(() => { process.exit = originalExit; vi.restoreAllMocks(); });

  const exitCodeOf = (err: unknown): number => {
    try { handleError(err); } catch (e) { return (e as ExitError).code; }
    throw new Error('did not exit');
  };

  it('exits 3 on NotAuthenticatedError', () => {
    expect(exitCodeOf(new NotAuthenticatedError())).toBe(3);
  });

  it('exits 4 on API 404', () => {
    expect(exitCodeOf(new ApiError(404, 'Not found'))).toBe(4);
  });

  it('exits 1 on other API errors', () => {
    expect(exitCodeOf(new ApiError(422, 'Invalid'))).toBe(1);
  });

  it('exits 2 on MissingFlagsError and emits flags in JSON mode', () => {
    setJsonMode(true);
    expect(exitCodeOf(new MissingFlagsError(['--name']))).toBe(2);
    // Errors now travel in the same envelope as results, on stdout — a caller
    // that captured only stdout used to get nothing at all on failure.
    const payload = JSON.parse((logSpy.mock.calls.at(-1)![0]) as string);
    expect(payload.success).toBe(false);
    expect(payload.data).toBeNull();
    expect(payload.error).toMatchObject({ code: 'missing_required_flag', flags: ['--name'] });
  });

  it('exits 5 on ConfirmationRequiredError', () => {
    expect(exitCodeOf(new ConfirmationRequiredError('VPS vps-1'))).toBe(5);
  });

  it('exits 4 on ResourceNotFoundError', () => {
    expect(exitCodeOf(new ResourceNotFoundError("VPS 'x' not found."))).toBe(4);
  });

  it('emits code "not_found" for ResourceNotFoundError in JSON mode', () => {
    setJsonMode(true);
    expect(exitCodeOf(new ResourceNotFoundError("VPS 'x' not found."))).toBe(4);
    const payload = JSON.parse((logSpy.mock.calls.at(-1)![0]) as string);
    expect(payload.error).toMatchObject({ code: 'not_found', message: "VPS 'x' not found." });
  });

  it('exits 130 with "Cancelled." on aborted prompt', () => {
    const err = new Error('User force closed the prompt with 0 null');
    err.name = 'ExitPromptError';
    expect(exitCodeOf(err)).toBe(130);
    expect(logSpy).toHaveBeenCalledWith('Cancelled.');
  });
});
