import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Polling is the behaviour under test; actually sleeping between polls would
// make the suite take minutes to assert something that is purely logical.
vi.mock('../../../src/lib/sleep.js', () => ({ sleep: vi.fn(() => Promise.resolve()) }));

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: { create: () => Promise.resolve({ get: mockGet, post: mockPost }) },
}));

const { runCommand } = await import('../../../src/commands/serverless/run.js');
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

const makeRun = (overrides: Record<string, unknown> = {}) => ({
  id: 'run-1', container_id: 'c-1', status: 'queued', terminal: false,
  command: null, image: 'nginx:latest', env_keys: [], timeout_seconds: 900,
  exit_code: null, message: null, created_at: '2026-09-16T00:00:00Z',
  started_at: null, finished_at: null, duration_seconds: null,
  ...overrides,
});

/** Routes GETs by shape: the container list, a run poll, or a logs poll. */
function mockGetRouter(opts: { runSeq?: unknown[]; logsSeq?: unknown[] } = {}) {
  const runSeq = opts.runSeq ?? [];
  const logsSeq = opts.logsSeq ?? [{ data: { run_id: 'run-1', source: 'live', logs: '' } }];
  let runCall = 0;
  let logsCall = 0;

  mockGet.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/serverless?')) return Promise.resolve(listResponse());
    if (path.endsWith('/logs')) {
      const resp = logsSeq[Math.min(logsCall, logsSeq.length - 1)];
      logsCall++;
      return Promise.resolve(resp);
    }
    const resp = runSeq[Math.min(runCall, runSeq.length - 1)];
    runCall++;
    return Promise.resolve(resp);
  });
}

describe('rapids run', () => {
  const originalExit = process.exit;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
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

  it('captures everything after -- as the command array, flags untouched', async () => {
    mockGet.mockResolvedValue(listResponse());
    mockPost.mockResolvedValue({ data: makeRun() });

    await runCommand.parseAsync(['node', 'test', 'my-api', '--', 'php', 'artisan', 'migrate', '--force']);

    expect(mockPost).toHaveBeenCalledWith('/api/v1/serverless/c-1/runs', {
      command: ['php', 'artisan', 'migrate', '--force'],
    });
  });

  it('omits command from the body when none is given', async () => {
    mockGet.mockResolvedValue(listResponse());
    mockPost.mockResolvedValue({ data: makeRun() });

    await runCommand.parseAsync(['node', 'test', 'my-api']);

    expect(mockPost).toHaveBeenCalledWith('/api/v1/serverless/c-1/runs', {});
  });

  it('maps --tag to image_tag', async () => {
    mockGet.mockResolvedValue(listResponse());
    mockPost.mockResolvedValue({ data: makeRun() });

    await runCommand.parseAsync(['node', 'test', 'my-api', '--tag', 'v2']);

    expect(mockPost).toHaveBeenCalledWith('/api/v1/serverless/c-1/runs', { image_tag: 'v2' });
  });

  it('maps --env pairs to an env object', async () => {
    mockGet.mockResolvedValue(listResponse());
    mockPost.mockResolvedValue({ data: makeRun() });

    await runCommand.parseAsync(['node', 'test', 'my-api', '--env', 'A=1', 'B=2']);

    expect(mockPost).toHaveBeenCalledWith('/api/v1/serverless/c-1/runs', { env: { A: '1', B: '2' } });
  });

  it('exits 1 on invalid env format (no equals sign)', async () => {
    mockGet.mockResolvedValue(listResponse());

    await expect(runCommand.parseAsync(['node', 'test', 'my-api', '--env', 'BAD'])).rejects.toThrow(ExitError);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.flat().join('\n')).toContain('Invalid env format');
  });

  it('maps --timeout to timeout_seconds, converted from a duration to whole seconds', async () => {
    mockGet.mockResolvedValue(listResponse());
    mockPost.mockResolvedValue({ data: makeRun() });

    await runCommand.parseAsync(['node', 'test', 'my-api', '--timeout', '10m']);

    expect(mockPost).toHaveBeenCalledWith('/api/v1/serverless/c-1/runs', { timeout_seconds: 600 });
  });

  it('rejects an unparseable --timeout rather than silently defaulting', async () => {
    mockGet.mockResolvedValue(listResponse());

    await expect(
      runCommand.parseAsync(['node', 'test', 'my-api', '--timeout', 'nonsense']),
    ).rejects.toThrow(/Invalid duration/);
  });

  describe('without --wait', () => {
    it('prints the run id and status, and exits 0', async () => {
      mockGet.mockResolvedValue(listResponse());
      mockPost.mockResolvedValue({ data: makeRun({ status: 'queued' }) });

      await runCommand.parseAsync(['node', 'test', 'my-api']);

      expect(logSpy.mock.calls.flat().join('\n')).toContain('run-1');
      expect(process.exitCode).toBeUndefined();
    });

    it('outputs the run object as JSON in json mode', async () => {
      setJsonMode(true);
      mockGet.mockResolvedValue(listResponse());
      mockPost.mockResolvedValue({ data: makeRun({ status: 'queued' }) });

      await runCommand.parseAsync(['node', 'test', 'my-api']);

      const printed = JSON.parse(logSpy.mock.calls.at(-1)![0] as string);
      expect(printed.data.id).toBe('run-1');
      expect(printed.data.status).toBe('queued');
    });

    it('makes no run/logs polling calls without --wait', async () => {
      mockGet.mockResolvedValue(listResponse());
      mockPost.mockResolvedValue({ data: makeRun() });

      await runCommand.parseAsync(['node', 'test', 'my-api']);

      // Only resolveContainer's list GET.
      expect(mockGet).toHaveBeenCalledTimes(1);
    });
  });

  describe('409 run_in_progress', () => {
    it('prints the active run id and exits 1, text mode', async () => {
      mockGet.mockResolvedValue(listResponse());
      mockPost.mockRejectedValue(new ApiError(
        409,
        'A run is already active.',
        undefined,
        { code: 'serverless.run_in_progress', retryable: false },
        { active_run_id: 'run-active' },
      ));

      await expect(runCommand.parseAsync(['node', 'test', 'my-api'])).rejects.toThrow(ExitError);

      expect(process.exit).toHaveBeenCalledWith(1);
      const out = errSpy.mock.calls.flat().join('\n');
      expect(out).toContain('A run is already active.');
      expect(out).toContain('run-active');
    });

    it('emits a structured envelope with active_run_id in meta, json mode', async () => {
      setJsonMode(true);
      mockGet.mockResolvedValue(listResponse());
      mockPost.mockRejectedValue(new ApiError(
        409,
        'A run is already active.',
        undefined,
        { code: 'serverless.run_in_progress', retryable: false },
        { active_run_id: 'run-active' },
      ));

      await expect(runCommand.parseAsync(['node', 'test', 'my-api'])).rejects.toThrow(ExitError);

      expect(process.exit).toHaveBeenCalledWith(1);
      const payload = JSON.parse(logSpy.mock.calls.at(-1)![0] as string);
      expect(payload.success).toBe(false);
      expect(payload.error.code).toBe('serverless.run_in_progress');
      expect(payload.meta.active_run_id).toBe('run-active');
    });

    it('handles a 409 with no active_run_id in meta and no cause', async () => {
      mockGet.mockResolvedValue(listResponse());
      mockPost.mockRejectedValue(new ApiError(409, 'A run is already active.'));

      await expect(runCommand.parseAsync(['node', 'test', 'my-api'])).rejects.toThrow(ExitError);

      expect(process.exit).toHaveBeenCalledWith(1);
      expect(errSpy.mock.calls.flat().join('\n')).toContain('A run is already active.');
    });

    it('defaults the error code and retryable when json mode gets a 409 with no cause', async () => {
      setJsonMode(true);
      mockGet.mockResolvedValue(listResponse());
      mockPost.mockRejectedValue(new ApiError(409, 'A run is already active.'));

      await expect(runCommand.parseAsync(['node', 'test', 'my-api'])).rejects.toThrow(ExitError);

      const payload = JSON.parse(logSpy.mock.calls.at(-1)![0] as string);
      expect(payload.error.code).toBe('serverless.run_in_progress');
      expect(payload.error.retryable).toBe(false);
      expect(payload.meta.active_run_id).toBeNull();
    });
  });

  describe('404 not enabled', () => {
    it('prints the not-enabled message and exits 1', async () => {
      mockGet.mockResolvedValue(listResponse());
      mockPost.mockRejectedValue(new ApiError(404, 'Not Found'));

      await expect(runCommand.parseAsync(['node', 'test', 'my-api'])).rejects.toThrow(ExitError);

      expect(process.exit).toHaveBeenCalledWith(1);
      expect(errSpy.mock.calls.flat().join('\n')).toContain('Rapids runs are not enabled for this account yet.');
    });
  });

  describe('--wait', () => {
    it('exits 0 on succeeded', async () => {
      mockGetRouter({ runSeq: [{ data: makeRun({ status: 'succeeded', terminal: true, exit_code: 0 }) }] });
      mockPost.mockResolvedValue({ data: makeRun({ status: 'queued' }) });

      await runCommand.parseAsync(['node', 'test', 'my-api', '--wait']);

      expect(process.exitCode).toBeUndefined();
      // printRunOutcome's succeeded branch goes to stdout; only progress/failure lines go to stderr.
      expect(logSpy.mock.calls.flat().join('\n')).toContain('succeeded');
    });

    it('exits with the run exit code on failed', async () => {
      mockGetRouter({ runSeq: [{ data: makeRun({ status: 'failed', terminal: true, exit_code: 3 }) }] });
      mockPost.mockResolvedValue({ data: makeRun({ status: 'queued' }) });

      await runCommand.parseAsync(['node', 'test', 'my-api', '--wait']);

      expect(process.exitCode).toBe(3);
    });

    it('exits 124 on timed_out', async () => {
      mockGetRouter({ runSeq: [{ data: makeRun({ status: 'timed_out', terminal: true }) }] });
      mockPost.mockResolvedValue({ data: makeRun({ status: 'queued' }) });

      await runCommand.parseAsync(['node', 'test', 'my-api', '--wait']);

      expect(process.exitCode).toBe(124);
    });

    it('exits 130 on cancelled', async () => {
      mockGetRouter({ runSeq: [{ data: makeRun({ status: 'cancelled', terminal: true }) }] });
      mockPost.mockResolvedValue({ data: makeRun({ status: 'queued' }) });

      await runCommand.parseAsync(['node', 'test', 'my-api', '--wait']);

      expect(process.exitCode).toBe(130);
    });

    it('exits 75 when the client wait-timeout elapses before the run settles', async () => {
      mockGetRouter({ runSeq: [{ data: makeRun({ status: 'running', terminal: false }) }] });
      mockPost.mockResolvedValue({ data: makeRun({ status: 'queued' }) });

      await runCommand.parseAsync(['node', 'test', 'my-api', '--wait', '--wait-timeout', '1s']);

      expect(process.exitCode).toBe(75);
      expect(errSpy.mock.calls.flat().join('\n')).toContain('client gave up waiting');
    });

    it('exits 1 on an invalid --wait-timeout, matching apply/update', async () => {
      mockGet.mockResolvedValue(listResponse());
      mockPost.mockResolvedValue({ data: makeRun({ status: 'queued' }) });

      await expect(
        runCommand.parseAsync(['node', 'test', 'my-api', '--wait', '--wait-timeout', 'nonsense']),
      ).rejects.toThrow(ExitError);
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('streams new log text to stderr while waiting', async () => {
      mockGetRouter({
        runSeq: [{ data: makeRun({ status: 'succeeded', terminal: true, exit_code: 0 }) }],
        logsSeq: [{ data: { run_id: 'run-1', source: 'live', logs: 'building...\n' } }],
      });
      mockPost.mockResolvedValue({ data: makeRun({ status: 'queued' }) });

      await runCommand.parseAsync(['node', 'test', 'my-api', '--wait']);

      expect(stderrWriteSpy.mock.calls.flat().join('')).toContain('building...');
      expect(stdoutWriteSpy).not.toHaveBeenCalled();
    });

    it('does not fetch logs at all with --no-logs', async () => {
      mockGetRouter({ runSeq: [{ data: makeRun({ status: 'succeeded', terminal: true, exit_code: 0 }) }] });
      mockPost.mockResolvedValue({ data: makeRun({ status: 'queued' }) });

      await runCommand.parseAsync(['node', 'test', 'my-api', '--wait', '--no-logs']);

      expect(mockGet).not.toHaveBeenCalledWith(expect.stringContaining('/logs'));
    });

    it('emits a JSON envelope in json mode', async () => {
      setJsonMode(true);
      mockGetRouter({ runSeq: [{ data: makeRun({ status: 'succeeded', terminal: true, exit_code: 0 }) }] });
      mockPost.mockResolvedValue({ data: makeRun({ status: 'queued' }) });

      await runCommand.parseAsync(['node', 'test', 'my-api', '--wait']);

      const payload = JSON.parse(logSpy.mock.calls.at(-1)![0] as string);
      expect(payload.data.status).toBe('succeeded');
      expect(payload.success).toBe(true);
    });

    it('reports the not-enabled message if the flag is off mid-wait', async () => {
      mockGet.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/serverless?')) return Promise.resolve(listResponse());
        return Promise.reject(new ApiError(404, 'Not Found'));
      });
      mockPost.mockResolvedValue({ data: makeRun({ status: 'queued' }) });

      await expect(runCommand.parseAsync(['node', 'test', 'my-api', '--wait'])).rejects.toThrow(ExitError);

      expect(process.exit).toHaveBeenCalledWith(1);
      expect(errSpy.mock.calls.flat().join('\n')).toContain('Rapids runs are not enabled for this account yet.');
    });
  });
});
