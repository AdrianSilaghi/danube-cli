import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Deliberately NOT mocking lib/sleep.js here (contrast run.test.ts): every
// non-follow test below settles on the first poll, so sleep is never called,
// and the one test that needs multiple polls (--follow's client-timeout case,
// against the DEFAULT_WAIT_TIMEOUT_MS ceiling with no CLI override) drives
// the real sleep()'s setTimeout through fake timers instead — a
// Promise.resolve()-mocked sleep would spin the polling loop as fast as the
// CPU allows, since nothing would ever yield to the fake-timer clock.

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: { create: () => Promise.resolve({ get: mockGet, post: mockPost }) },
}));

const { lsCommand, showCommand, logsCommand, cancelCommand } = await import('../../../src/commands/serverless/runs.js');
const { setJsonMode } = await import('../../../src/lib/json-mode.js');
const { ApiError } = await import('../../../src/lib/errors.js');

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

const makeContainer = (overrides: Record<string, unknown> = {}) => ({
  id: 'c-1', name: 'my-api', slug: 'my-api', deployment_type: 'docker_image',
  source_type: null, image: 'nginx', image_tag: 'latest', port: 8080,
  resource_profile: 'basic', min_scale: 0, max_scale: 10, status: 'running',
  scaling_metric: 'rps', scaling_target: 100, concurrency_target: 100,
  timeout_seconds: 300, environment_variables: null, current_replicas: 1,
  url: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

const listResponse = () => ({ data: [makeContainer()] });

const isListCall = (path: string) => path.startsWith('/api/v1/serverless?');

const makeRun = (overrides: Record<string, unknown> = {}) => ({
  id: 'run-1', container_id: 'c-1', status: 'succeeded', terminal: true,
  command: ['npm', 'run', 'migrate'], image: 'nginx:latest', env_keys: ['A'],
  timeout_seconds: 900, exit_code: 0, message: null,
  created_at: '2026-09-16T00:00:00Z', started_at: '2026-09-16T00:00:01Z',
  finished_at: '2026-09-16T00:00:05Z', duration_seconds: 4,
  ...overrides,
});

describe('rapids runs', () => {
  const originalExit = process.exit;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.exit = vi.fn().mockImplementation((code: number) => {
      throw new ExitError(code);
    }) as never;
    mockGet.mockReset();
    mockPost.mockReset();
  });

  afterEach(() => {
    process.exit = originalExit;
    process.exitCode = undefined;
    setJsonMode(false);
    vi.restoreAllMocks();
  });

  describe('ls', () => {
    it('prints a table of runs', async () => {
      mockGet.mockImplementation((path: string) =>
        Promise.resolve(isListCall(path) ? listResponse() : { data: [makeRun()], meta: { total: 1 } }));

      await lsCommand.parseAsync(['node', 'test', 'my-api']);

      expect(logSpy.mock.calls.flat().join('\n')).toContain('run-1');
    });

    it('reports no runs yet', async () => {
      mockGet.mockImplementation((path: string) => Promise.resolve(isListCall(path) ? listResponse() : { data: [] }));

      await lsCommand.parseAsync(['node', 'test', 'my-api']);

      expect(logSpy.mock.calls.flat().join('\n')).toContain('No runs yet.');
    });

    it('notes truncation when more runs exist than were returned', async () => {
      mockGet.mockImplementation((path: string) =>
        Promise.resolve(isListCall(path) ? listResponse() : { data: [makeRun()], meta: { total: 5 } }));

      await lsCommand.parseAsync(['node', 'test', 'my-api']);

      expect(logSpy.mock.calls.flat().join('\n')).toContain('Showing 1 of 5');
    });

    it('does not note truncation when everything was returned', async () => {
      mockGet.mockImplementation((path: string) =>
        Promise.resolve(isListCall(path) ? listResponse() : { data: [makeRun()], meta: { total: 1 } }));

      await lsCommand.parseAsync(['node', 'test', 'my-api']);

      expect(logSpy.mock.calls.flat().join('\n')).not.toContain('Showing');
    });

    it('outputs the envelope as JSON in json mode', async () => {
      setJsonMode(true);
      mockGet.mockImplementation((path: string) =>
        Promise.resolve(isListCall(path) ? listResponse() : { data: [makeRun()], meta: { total: 1 } }));

      await lsCommand.parseAsync(['node', 'test', 'my-api']);

      const payload = JSON.parse(logSpy.mock.calls.at(-1)![0] as string);
      expect(payload.data[0].id).toBe('run-1');
      expect(payload.meta.total).toBe(1);
    });

    it('renders a run with no override command as image default', async () => {
      mockGet.mockImplementation((path: string) =>
        Promise.resolve(isListCall(path) ? listResponse() : { data: [makeRun({ command: null })] }));

      await lsCommand.parseAsync(['node', 'test', 'my-api']);

      expect(logSpy.mock.calls.flat().join('\n')).toContain('image default');
    });

    it('renders dashes for a queued run with no exit code, start time, or duration yet', async () => {
      mockGet.mockImplementation((path: string) => Promise.resolve(isListCall(path) ? listResponse() : {
        data: [makeRun({ status: 'queued', exit_code: null, started_at: null, duration_seconds: null })],
      }));

      await lsCommand.parseAsync(['node', 'test', 'my-api']);

      expect(logSpy.mock.calls.flat().join('\n')).toContain('run-1');
    });

    it('prints the not-enabled message and exits 1 on 404', async () => {
      mockGet.mockImplementation((path: string) =>
        isListCall(path) ? Promise.resolve(listResponse()) : Promise.reject(new ApiError(404, 'Not Found')));

      await expect(lsCommand.parseAsync(['node', 'test', 'my-api'])).rejects.toThrow(ExitError);

      expect(process.exit).toHaveBeenCalledWith(1);
      expect(errSpy.mock.calls.flat().join('\n')).toContain('Rapids runs are not enabled for this account yet.');
    });
  });

  describe('show', () => {
    it('prints run details', async () => {
      mockGet.mockImplementation((path: string) => Promise.resolve(isListCall(path) ? listResponse() : { data: makeRun() }));

      await showCommand.parseAsync(['node', 'test', 'my-api', 'run-1']);

      const out = logSpy.mock.calls.flat().join('\n');
      expect(out).toContain('run-1');
      expect(out).toContain('nginx:latest');
    });

    it('prints the run message when present', async () => {
      mockGet.mockImplementation((path: string) =>
        Promise.resolve(isListCall(path) ? listResponse() : { data: makeRun({ message: 'exited 0' }) }));

      await showCommand.parseAsync(['node', 'test', 'my-api', 'run-1']);

      expect(logSpy.mock.calls.flat().join('\n')).toContain('exited 0');
    });

    it('outputs JSON in json mode', async () => {
      setJsonMode(true);
      mockGet.mockImplementation((path: string) => Promise.resolve(isListCall(path) ? listResponse() : { data: makeRun() }));

      await showCommand.parseAsync(['node', 'test', 'my-api', 'run-1']);

      const payload = JSON.parse(logSpy.mock.calls.at(-1)![0] as string);
      expect(payload.data.id).toBe('run-1');
    });

    it('renders dashes for a run with no exit code, start/finish time, or duration yet', async () => {
      mockGet.mockImplementation((path: string) => Promise.resolve(isListCall(path) ? listResponse() : {
        data: makeRun({
          status: 'queued', exit_code: null, started_at: null, finished_at: null, duration_seconds: null,
        }),
      }));

      await showCommand.parseAsync(['node', 'test', 'my-api', 'run-1']);

      expect(logSpy.mock.calls.flat().join('\n')).toContain('run-1');
    });

    it('prints "run not found" (not the not-enabled message) on an uncoded 404', async () => {
      mockGet.mockImplementation((path: string) =>
        isListCall(path) ? Promise.resolve(listResponse()) : Promise.reject(new ApiError(404, 'Not Found')));

      await expect(showCommand.parseAsync(['node', 'test', 'my-api', 'run-1'])).rejects.toThrow(ExitError);

      expect(process.exit).toHaveBeenCalledWith(1);
      const out = errSpy.mock.calls.flat().join('\n');
      expect(out).toContain('Run run-1 was not found on my-api.');
      expect(out).not.toContain('not enabled');
    });

    it('prints the not-enabled message on a 404 that carries the not-enabled code', async () => {
      mockGet.mockImplementation((path: string) =>
        isListCall(path)
          ? Promise.resolve(listResponse())
          : Promise.reject(new ApiError(404, 'Not Found', undefined, { code: 'serverless.runs_not_enabled' })));

      await expect(showCommand.parseAsync(['node', 'test', 'my-api', 'run-1'])).rejects.toThrow(ExitError);

      expect(process.exit).toHaveBeenCalledWith(1);
      expect(errSpy.mock.calls.flat().join('\n')).toContain('Rapids runs are not enabled for this account yet.');
    });
  });

  describe('logs (no --follow)', () => {
    it('prints the log text', async () => {
      mockGet.mockImplementation((path: string) =>
        Promise.resolve(isListCall(path) ? listResponse() : { data: { run_id: 'run-1', source: 'stored', logs: 'hello\n' } }));

      await logsCommand.parseAsync(['node', 'test', 'my-api', 'run-1']);

      expect(logSpy.mock.calls.flat().join('\n')).toContain('hello');
    });

    it('reports no logs yet for empty text', async () => {
      mockGet.mockImplementation((path: string) =>
        Promise.resolve(isListCall(path) ? listResponse() : { data: { run_id: 'run-1', source: 'none', logs: '' } }));

      await logsCommand.parseAsync(['node', 'test', 'my-api', 'run-1']);

      expect(logSpy.mock.calls.flat().join('\n')).toContain('No logs yet.');
    });

    it('outputs JSON in json mode', async () => {
      setJsonMode(true);
      mockGet.mockImplementation((path: string) =>
        Promise.resolve(isListCall(path) ? listResponse() : { data: { run_id: 'run-1', source: 'live', logs: 'hi\n' } }));

      await logsCommand.parseAsync(['node', 'test', 'my-api', 'run-1']);

      const payload = JSON.parse(logSpy.mock.calls.at(-1)![0] as string);
      expect(payload.data.logs).toBe('hi\n');
    });

    it('makes a single fetch — no polling', async () => {
      mockGet.mockImplementation((path: string) =>
        Promise.resolve(isListCall(path) ? listResponse() : { data: { run_id: 'run-1', source: 'live', logs: '' } }));

      await logsCommand.parseAsync(['node', 'test', 'my-api', 'run-1']);

      // resolveContainer's list + one logs fetch.
      expect(mockGet).toHaveBeenCalledTimes(2);
    });

    it('prints "run not found" (not the not-enabled message) on an uncoded 404', async () => {
      mockGet.mockImplementation((path: string) =>
        isListCall(path) ? Promise.resolve(listResponse()) : Promise.reject(new ApiError(404, 'Not Found')));

      await expect(logsCommand.parseAsync(['node', 'test', 'my-api', 'run-1'])).rejects.toThrow(ExitError);

      expect(process.exit).toHaveBeenCalledWith(1);
      const out = errSpy.mock.calls.flat().join('\n');
      expect(out).toContain('Run run-1 was not found on my-api.');
      expect(out).not.toContain('not enabled');
    });

    it('prints the not-enabled message on a 404 that carries the not-enabled code', async () => {
      mockGet.mockImplementation((path: string) =>
        isListCall(path)
          ? Promise.resolve(listResponse())
          : Promise.reject(new ApiError(404, 'Not Found', undefined, { code: 'serverless.runs_not_enabled' })));

      await expect(logsCommand.parseAsync(['node', 'test', 'my-api', 'run-1'])).rejects.toThrow(ExitError);

      expect(process.exit).toHaveBeenCalledWith(1);
      expect(errSpy.mock.calls.flat().join('\n')).toContain('Rapids runs are not enabled for this account yet.');
    });
  });

  describe('logs --follow', () => {
    function router(opts: { runSeq: unknown[]; logsSeq: unknown[] }) {
      let ri = 0;
      let li = 0;
      mockGet.mockImplementation((path: string) => {
        if (isListCall(path)) return Promise.resolve(listResponse());
        if (path.endsWith('/logs')) {
          const r = opts.logsSeq[Math.min(li, opts.logsSeq.length - 1)];
          li++;
          return Promise.resolve(r);
        }
        const r = opts.runSeq[Math.min(ri, opts.runSeq.length - 1)];
        ri++;
        return Promise.resolve(r);
      });
    }

    it('streams new text to stdout and exits 0 on succeeded', async () => {
      router({
        runSeq: [{ data: makeRun({ status: 'succeeded', terminal: true, exit_code: 0 }) }],
        logsSeq: [{ data: { run_id: 'run-1', source: 'live', logs: 'all done\n' } }],
      });

      await logsCommand.parseAsync(['node', 'test', 'my-api', 'run-1', '--follow']);

      expect(stdoutWriteSpy.mock.calls.flat().join('')).toContain('all done');
      expect(process.exitCode).toBeUndefined();
    });

    it('exits with the run exit code on failed', async () => {
      router({
        runSeq: [{ data: makeRun({ status: 'failed', terminal: true, exit_code: 5 }) }],
        logsSeq: [{ data: { run_id: 'run-1', source: 'live', logs: '' } }],
      });

      await logsCommand.parseAsync(['node', 'test', 'my-api', 'run-1', '--follow']);

      expect(process.exitCode).toBe(5);
    });

    it('does not stream to stdout in json mode, but still emits the final envelope with the logs', async () => {
      setJsonMode(true);
      router({
        runSeq: [{ data: makeRun({ status: 'succeeded', terminal: true, exit_code: 0 }) }],
        logsSeq: [{ data: { run_id: 'run-1', source: 'live', logs: 'quiet\n' } }],
      });

      await logsCommand.parseAsync(['node', 'test', 'my-api', 'run-1', '--follow']);

      expect(stdoutWriteSpy).not.toHaveBeenCalled();
      const payload = JSON.parse(logSpy.mock.calls.at(-1)![0] as string);
      expect(payload.data.logs).toBe('quiet\n');
      expect(payload.success).toBe(true);
    });

    it('exits 75 and reports the client gave up when the run does not settle in time', async () => {
      // --follow has no CLI override, so this waits out the full
      // DEFAULT_WAIT_TIMEOUT_MS (10 min) — driven via fake timers against the
      // REAL sleep() rather than actually waiting, matching wait-for-terminal.test.ts.
      vi.useFakeTimers();
      router({
        runSeq: [{ data: makeRun({ status: 'running', terminal: false }) }],
        logsSeq: [{ data: { run_id: 'run-1', source: 'live', logs: '' } }],
      });

      const promise = logsCommand.parseAsync(['node', 'test', 'my-api', 'run-1', '--follow']);
      await vi.advanceTimersByTimeAsync(650_000);
      await promise;
      vi.useRealTimers();

      expect(process.exitCode).toBe(75);
      expect(errSpy.mock.calls.flat().join('\n')).toContain('client gave up waiting');
    });

    it('emits the client-timeout error in the json envelope when it does not settle in time', async () => {
      setJsonMode(true);
      vi.useFakeTimers();
      router({
        runSeq: [{ data: makeRun({ status: 'running', terminal: false }) }],
        logsSeq: [{ data: { run_id: 'run-1', source: 'live', logs: '' } }],
      });

      const promise = logsCommand.parseAsync(['node', 'test', 'my-api', 'run-1', '--follow']);
      await vi.advanceTimersByTimeAsync(650_000);
      await promise;
      vi.useRealTimers();

      expect(process.exitCode).toBe(75);
      const payload = JSON.parse(logSpy.mock.calls.at(-1)![0] as string);
      expect(payload.success).toBe(false);
      expect(payload.error.code).toBe('serverless.run_wait_timeout');
    });

    it('reports the run as disappeared, not as not-enabled, on an uncoded 404 mid-follow', async () => {
      mockGet.mockImplementation((path: string) => {
        if (isListCall(path)) return Promise.resolve(listResponse());
        return Promise.reject(new ApiError(404, 'Not Found'));
      });

      await expect(
        logsCommand.parseAsync(['node', 'test', 'my-api', 'run-1', '--follow']),
      ).rejects.toThrow(ExitError);

      expect(process.exit).toHaveBeenCalledWith(1);
      const out = errSpy.mock.calls.flat().join('\n');
      expect(out).toContain('Run run-1 disappeared while waiting for it to finish.');
      expect(out).not.toContain('not enabled');
    });

    it('reports the run as disappeared when the run settles but the final logs fetch 404s', async () => {
      // Distinct from the wait's own poll 404ing: here the run itself is
      // found and settles normally, and only the logs fetch AFTER the wait
      // loop ends comes back 404 — its own onMissing callback, not the one
      // wired into waitForRun's poll.
      let logsCall = 0;
      mockGet.mockImplementation((path: string) => {
        if (isListCall(path)) return Promise.resolve(listResponse());
        if (path.endsWith('/logs')) {
          logsCall++;
          return logsCall === 1
            ? Promise.resolve({ data: { run_id: 'run-1', source: 'live', logs: '' } })
            : Promise.reject(new ApiError(404, 'Not Found'));
        }
        return Promise.resolve({ data: makeRun({ status: 'succeeded', terminal: true, exit_code: 0 }) });
      });

      await expect(
        logsCommand.parseAsync(['node', 'test', 'my-api', 'run-1', '--follow']),
      ).rejects.toThrow(ExitError);

      expect(process.exit).toHaveBeenCalledWith(1);
      expect(errSpy.mock.calls.flat().join('\n')).toContain('Run run-1 disappeared while waiting for it to finish.');
    });

    it('reports not-enabled on a coded 404 mid-follow', async () => {
      mockGet.mockImplementation((path: string) => {
        if (isListCall(path)) return Promise.resolve(listResponse());
        return Promise.reject(new ApiError(404, 'Not Found', undefined, { code: 'serverless.runs_not_enabled' }));
      });

      await expect(
        logsCommand.parseAsync(['node', 'test', 'my-api', 'run-1', '--follow']),
      ).rejects.toThrow(ExitError);

      expect(process.exit).toHaveBeenCalledWith(1);
      expect(errSpy.mock.calls.flat().join('\n')).toContain('Rapids runs are not enabled for this account yet.');
    });
  });

  describe('cancel', () => {
    it('requests cancellation and prints the status', async () => {
      mockGet.mockResolvedValue(listResponse());
      mockPost.mockResolvedValue({ data: makeRun({ status: 'cancelled', terminal: true }) });

      await cancelCommand.parseAsync(['node', 'test', 'my-api', 'run-1']);

      expect(mockPost).toHaveBeenCalledWith('/api/v1/serverless/c-1/runs/run-1/cancel');
      expect(logSpy.mock.calls.flat().join('\n')).toContain('run-1');
    });

    it('outputs JSON in json mode', async () => {
      setJsonMode(true);
      mockGet.mockResolvedValue(listResponse());
      mockPost.mockResolvedValue({ data: makeRun({ status: 'cancelled', terminal: true }) });

      await cancelCommand.parseAsync(['node', 'test', 'my-api', 'run-1']);

      const payload = JSON.parse(logSpy.mock.calls.at(-1)![0] as string);
      expect(payload.data.status).toBe('cancelled');
    });

    it('reports 409 run_not_active and exits 1, text mode', async () => {
      mockGet.mockResolvedValue(listResponse());
      mockPost.mockRejectedValue(new ApiError(
        409,
        'The run is not active.',
        undefined,
        { code: 'serverless.run_not_active', retryable: false },
      ));

      await expect(cancelCommand.parseAsync(['node', 'test', 'my-api', 'run-1'])).rejects.toThrow(ExitError);

      expect(process.exit).toHaveBeenCalledWith(1);
      expect(errSpy.mock.calls.flat().join('\n')).toContain('The run is not active.');
    });

    it('reports 409 run_not_active and exits 1, json mode, defaulting the code when no cause is given', async () => {
      setJsonMode(true);
      mockGet.mockResolvedValue(listResponse());
      mockPost.mockRejectedValue(new ApiError(409, 'The run is not active.'));

      await expect(cancelCommand.parseAsync(['node', 'test', 'my-api', 'run-1'])).rejects.toThrow(ExitError);

      expect(process.exit).toHaveBeenCalledWith(1);
      const payload = JSON.parse(logSpy.mock.calls.at(-1)![0] as string);
      expect(payload.error.code).toBe('serverless.run_not_active');
    });

    it('prints "run not found" (not the not-enabled message) on an uncoded 404', async () => {
      mockGet.mockResolvedValue(listResponse());
      mockPost.mockRejectedValue(new ApiError(404, 'Not Found'));

      await expect(cancelCommand.parseAsync(['node', 'test', 'my-api', 'run-1'])).rejects.toThrow(ExitError);

      expect(process.exit).toHaveBeenCalledWith(1);
      const out = errSpy.mock.calls.flat().join('\n');
      expect(out).toContain('Run run-1 was not found on my-api.');
      expect(out).not.toContain('not enabled');
    });

    it('prints the not-enabled message on a 404 that carries the not-enabled code', async () => {
      mockGet.mockResolvedValue(listResponse());
      mockPost.mockRejectedValue(new ApiError(404, 'Not Found', undefined, { code: 'serverless.runs_not_enabled' }));

      await expect(cancelCommand.parseAsync(['node', 'test', 'my-api', 'run-1'])).rejects.toThrow(ExitError);

      expect(process.exit).toHaveBeenCalledWith(1);
      expect(errSpy.mock.calls.flat().join('\n')).toContain('Rapids runs are not enabled for this account yet.');
    });

    it('rethrows a non-409 API error rather than swallowing it', async () => {
      mockGet.mockResolvedValue(listResponse());
      mockPost.mockRejectedValue(new ApiError(500, 'server exploded'));

      await expect(cancelCommand.parseAsync(['node', 'test', 'my-api', 'run-1'])).rejects.toThrow('server exploded');
      expect(process.exit).not.toHaveBeenCalled();
    });
  });
});
