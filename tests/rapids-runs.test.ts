import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError } from '../src/lib/errors.js';
import { runsApi, RUNS_NOT_ENABLED_MESSAGE } from '../src/lib/rapids-runs.js';
import { setJsonMode } from '../src/lib/json-mode.js';

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

describe('runsApi', () => {
  const originalExit = process.exit;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.exit = vi.fn().mockImplementation((code: number) => {
      throw new ExitError(code);
    }) as never;
  });

  afterEach(() => {
    process.exit = originalExit;
    setJsonMode(false);
    vi.restoreAllMocks();
  });

  it('returns the resolved value when the call succeeds', async () => {
    await expect(runsApi(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('rethrows a non-404 ApiError untouched', async () => {
    const err = new ApiError(500, 'boom');
    await expect(runsApi(() => Promise.reject(err))).rejects.toBe(err);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('rethrows a non-ApiError untouched', async () => {
    const err = new Error('network blip');
    await expect(runsApi(() => Promise.reject(err))).rejects.toBe(err);
  });

  it('prints the not-enabled message and exits 1 on a 404 ApiError, text mode', async () => {
    await expect(runsApi(() => Promise.reject(new ApiError(404, 'Not Found')))).rejects.toThrow(ExitError);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining(RUNS_NOT_ENABLED_MESSAGE));
  });

  it('emits the JSON envelope and exits 1 on a 404 ApiError, json mode', async () => {
    setJsonMode(true);

    await expect(runsApi(() => Promise.reject(new ApiError(404, 'Not Found')))).rejects.toThrow(ExitError);

    expect(process.exit).toHaveBeenCalledWith(1);
    const printed = JSON.parse(consoleLogSpy.mock.calls.at(-1)![0] as string);
    expect(printed.success).toBe(false);
    expect(printed.error.code).toBe('serverless.runs_not_enabled');
    expect(printed.error.message).toBe(RUNS_NOT_ENABLED_MESSAGE);
  });
});
