import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError } from '../src/lib/errors.js';
import {
  runsApi,
  runsApiForRun,
  reportRunNotFound,
  reportRunDisappeared,
  RUNS_NOT_ENABLED_MESSAGE,
} from '../src/lib/rapids-runs.js';
import { setJsonMode } from '../src/lib/json-mode.js';

const notEnabledError = () => new ApiError(404, 'Not Found', undefined, { code: 'serverless.runs_not_enabled' });

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

describe('runsApiForRun', () => {
  const originalExit = process.exit;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  const onMissing = vi.fn(() => {
    throw new Error('onMissing did not call process.exit');
  });

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.exit = vi.fn().mockImplementation((code: number) => {
      throw new ExitError(code);
    }) as never;
    onMissing.mockClear();
  });

  afterEach(() => {
    process.exit = originalExit;
    setJsonMode(false);
    vi.restoreAllMocks();
  });

  it('returns the resolved value when the call succeeds', async () => {
    await expect(runsApiForRun(() => Promise.resolve('ok'), onMissing)).resolves.toBe('ok');
    expect(onMissing).not.toHaveBeenCalled();
  });

  it('rethrows a non-404 ApiError untouched, without calling onMissing', async () => {
    const err = new ApiError(500, 'boom');
    await expect(runsApiForRun(() => Promise.reject(err), onMissing)).rejects.toBe(err);
    expect(onMissing).not.toHaveBeenCalled();
  });

  it('rethrows a non-ApiError untouched', async () => {
    const err = new Error('network blip');
    await expect(runsApiForRun(() => Promise.reject(err), onMissing)).rejects.toBe(err);
  });

  it('reports not-enabled (not onMissing) on a CODED 404, regardless of which run was named', async () => {
    await expect(runsApiForRun(() => Promise.reject(notEnabledError()), onMissing)).rejects.toThrow(ExitError);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(onMissing).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining(RUNS_NOT_ENABLED_MESSAGE));
  });

  it('calls onMissing on an UNCODED 404', async () => {
    await expect(
      runsApiForRun(() => Promise.reject(new ApiError(404, 'Not Found')), onMissing),
    ).rejects.toThrow('onMissing did not call process.exit');

    expect(onMissing).toHaveBeenCalledTimes(1);
  });

  it('json mode: coded 404 emits the not-enabled envelope', async () => {
    setJsonMode(true);

    await expect(runsApiForRun(() => Promise.reject(notEnabledError()), onMissing)).rejects.toThrow(ExitError);

    const payload = JSON.parse(consoleLogSpy.mock.calls.at(-1)![0] as string);
    expect(payload.error.code).toBe('serverless.runs_not_enabled');
  });
});

describe('reportRunNotFound', () => {
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

  it('prints the run id and container name, and exits 1, text mode', () => {
    expect(() => reportRunNotFound('run-1', 'my-api')).toThrow(ExitError);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Run run-1 was not found on my-api.'));
  });

  it('emits the usual error envelope, json mode', () => {
    setJsonMode(true);

    expect(() => reportRunNotFound('run-1', 'my-api')).toThrow(ExitError);

    const payload = JSON.parse(consoleLogSpy.mock.calls.at(-1)![0] as string);
    expect(payload.success).toBe(false);
    expect(payload.error.code).toBe('not_found');
    expect(payload.error.message).toBe('Run run-1 was not found on my-api.');
  });
});

describe('reportRunDisappeared', () => {
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

  it('prints the run id and exits 1, text mode — distinct wording from not-found', () => {
    expect(() => reportRunDisappeared('run-1')).toThrow(ExitError);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Run run-1 disappeared while waiting'));
  });

  it('emits a distinct error code, json mode', () => {
    setJsonMode(true);

    expect(() => reportRunDisappeared('run-1')).toThrow(ExitError);

    const payload = JSON.parse(consoleLogSpy.mock.calls.at(-1)![0] as string);
    expect(payload.error.code).toBe('serverless.run_disappeared');
  });
});
