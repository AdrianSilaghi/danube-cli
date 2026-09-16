import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  exitCodeForRun,
  exitCodeForWait,
  runErrorEnvelope,
  clientWaitTimeoutError,
  runJsonEnvelope,
  printRunOutcome,
  printClientTimeout,
  printRunWaitOutcome,
  CLIENT_WAIT_TIMEOUT_EXIT_CODE,
} from '../src/lib/report-run.js';
import type { ServerlessRun } from '../src/types/api.js';
import type { RunWaitResult } from '../src/lib/wait-for-run.js';

const makeRun = (overrides: Partial<ServerlessRun> = {}): ServerlessRun => ({
  id: 'run-1',
  container_id: 'c-1',
  status: 'succeeded',
  terminal: true,
  command: ['npm', 'run', 'migrate'],
  image: 'nginx:latest',
  env_keys: [],
  timeout_seconds: 900,
  exit_code: 0,
  message: null,
  created_at: '2026-09-16T00:00:00Z',
  started_at: '2026-09-16T00:00:01Z',
  finished_at: '2026-09-16T00:00:05Z',
  duration_seconds: 4,
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('exitCodeForRun', () => {
  it('succeeded -> 0', () => {
    expect(exitCodeForRun(makeRun({ status: 'succeeded' }))).toBe(0);
  });

  it('failed -> the run exit code when it is a valid 1-255 code', () => {
    expect(exitCodeForRun(makeRun({ status: 'failed', exit_code: 3 }))).toBe(3);
  });

  it('failed -> 1 when exit_code is null', () => {
    expect(exitCodeForRun(makeRun({ status: 'failed', exit_code: null }))).toBe(1);
  });

  it('failed -> 1 when exit_code is out of the valid 1-255 range', () => {
    expect(exitCodeForRun(makeRun({ status: 'failed', exit_code: 0 }))).toBe(1);
    expect(exitCodeForRun(makeRun({ status: 'failed', exit_code: 256 }))).toBe(1);
    expect(exitCodeForRun(makeRun({ status: 'failed', exit_code: 1.5 }))).toBe(1);
  });

  it('timed_out -> 124', () => {
    expect(exitCodeForRun(makeRun({ status: 'timed_out' }))).toBe(124);
  });

  it('cancelled -> 130', () => {
    expect(exitCodeForRun(makeRun({ status: 'cancelled' }))).toBe(130);
  });

  it('a non-terminal status defensively maps to 1', () => {
    expect(exitCodeForRun(makeRun({ status: 'running' as ServerlessRun['status'] }))).toBe(1);
  });
});

describe('exitCodeForWait', () => {
  it('uses exitCodeForRun when settled', () => {
    const result: Pick<RunWaitResult, 'settled' | 'run'> = { settled: true, run: makeRun({ status: 'succeeded' }) };
    expect(exitCodeForWait(result)).toBe(0);
  });

  it('returns the client-timeout code when not settled', () => {
    const result: Pick<RunWaitResult, 'settled' | 'run'> = {
      settled: false,
      run: makeRun({ status: 'running' as ServerlessRun['status'] }),
    };
    expect(exitCodeForWait(result)).toBe(CLIENT_WAIT_TIMEOUT_EXIT_CODE);
    expect(CLIENT_WAIT_TIMEOUT_EXIT_CODE).toBe(75);
  });
});

describe('runErrorEnvelope', () => {
  it('is null for a succeeded run', () => {
    expect(runErrorEnvelope(makeRun({ status: 'succeeded' }))).toBeNull();
  });

  it('carries the run message and a non-retryable code for failed', () => {
    const err = runErrorEnvelope(makeRun({ status: 'failed', message: 'exit 1' }));
    expect(err).toEqual({ code: 'serverless.run_failed', message: 'exit 1', retryable: false });
  });

  it('is retryable for timed_out', () => {
    const err = runErrorEnvelope(makeRun({ status: 'timed_out', message: null }));
    expect(err).toEqual({ code: 'serverless.run_timed_out', message: undefined, retryable: true });
  });

  it('is non-retryable for cancelled', () => {
    const err = runErrorEnvelope(makeRun({ status: 'cancelled' }));
    expect(err?.retryable).toBe(false);
    expect(err?.code).toBe('serverless.run_cancelled');
  });
});

describe('clientWaitTimeoutError', () => {
  it('names the still-current status, elapsed time, and is retryable', () => {
    const err = clientWaitTimeoutError(makeRun({ status: 'running' as ServerlessRun['status'] }), 601_234);

    expect(err.code).toBe('serverless.run_wait_timeout');
    expect(err.message).toContain('running');
    expect(err.message).toContain('601s');
    expect(err.retryable).toBe(true);
  });
});

describe('runJsonEnvelope', () => {
  it('emits success with a null error when settled and succeeded', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    runJsonEnvelope({ settled: true, run: makeRun({ status: 'succeeded' }), waitedMs: 500 });

    const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(payload.success).toBe(true);
    expect(payload.error).toBeNull();
    expect(payload.meta).toEqual({ waited_ms: 500, settled: true });
  });

  it('emits the failed run error when settled and failed', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    runJsonEnvelope({ settled: true, run: makeRun({ status: 'failed', exit_code: 2 }), waitedMs: 500 });

    const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(payload.success).toBe(false);
    expect(payload.error.code).toBe('serverless.run_failed');
  });

  it('emits the client-timeout error when not settled', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    runJsonEnvelope({ settled: false, run: makeRun({ status: 'running' as ServerlessRun['status'] }), waitedMs: 600_000 });

    const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(payload.success).toBe(false);
    expect(payload.error.code).toBe('serverless.run_wait_timeout');
    expect(payload.meta).toEqual({ waited_ms: 600_000, settled: false });
  });
});

describe('printRunOutcome', () => {
  it('prints success to stdout only', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    printRunOutcome(makeRun({ status: 'succeeded' }));

    expect(logSpy.mock.calls.flat().join('\n')).toContain('succeeded');
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('prints failed with the exit code and message to stderr, plus a show hint', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    printRunOutcome(makeRun({ status: 'failed', exit_code: 3, message: 'boom' }));

    const out = errSpy.mock.calls.flat().join('\n');
    expect(out).toContain('failed');
    expect(out).toContain('exit 3');
    expect(out).toContain('boom');
    expect(out).toContain('danube rapids runs show c-1 run-1');
  });

  it('prints failed without a message line when message is null', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    printRunOutcome(makeRun({ status: 'failed', exit_code: null, message: null }));

    expect(errSpy).toHaveBeenCalled();
    expect(errSpy.mock.calls.flat().join('\n')).not.toContain('null');
  });

  it('prints timed_out with the timeout duration', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    printRunOutcome(makeRun({ status: 'timed_out', timeout_seconds: 900 }));

    expect(errSpy.mock.calls.flat().join('\n')).toContain('900s');
  });

  it('prints cancelled', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    printRunOutcome(makeRun({ status: 'cancelled' }));

    expect(errSpy.mock.calls.flat().join('\n')).toContain('cancelled');
  });

  it('prints a defensive message for an unexpected status', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    printRunOutcome(makeRun({ status: 'weird' as ServerlessRun['status'] }));

    expect(errSpy.mock.calls.flat().join('\n')).toContain("unexpected state 'weird'");
  });
});

describe('printClientTimeout', () => {
  it('prints the elapsed time and follow/show hints', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    printClientTimeout(makeRun({ status: 'running' as ServerlessRun['status'] }), 90_000);

    const out = errSpy.mock.calls.flat().join('\n');
    expect(out).toContain('90s');
    expect(out).toContain('danube rapids runs logs c-1 run-1 --follow');
    expect(out).toContain('danube rapids runs show c-1 run-1');
  });
});

describe('printRunWaitOutcome', () => {
  it('delegates to printRunOutcome when settled', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    printRunWaitOutcome({ settled: true, run: makeRun({ status: 'succeeded' }), waitedMs: 100 });

    expect(logSpy).toHaveBeenCalled();
  });

  it('delegates to printClientTimeout when not settled', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    printRunWaitOutcome({ settled: false, run: makeRun({ status: 'running' as ServerlessRun['status'] }), waitedMs: 100 });

    expect(errSpy).toHaveBeenCalled();
  });
});
