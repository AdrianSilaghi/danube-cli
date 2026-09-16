import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPut = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet, put: mockPut }),
  },
}));

vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  }),
}));

const { updateCommand } = await import('../../../src/commands/serverless/update.js');

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

const makeContainer = (overrides = {}) => ({
  id: 'abc-123', name: 'my-api', slug: 'my-api', deployment_type: 'docker_image',
  source_type: null, image: 'nginx', image_tag: 'latest', port: 8080,
  resource_profile: 'basic', min_scale: 0, max_scale: 10, status: 'running',
  scaling_metric: 'rps', scaling_target: 100, concurrency_target: 100,
  timeout_seconds: 300, environment_variables: null, current_replicas: 1,
  url: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

const listResponse = (overrides = {}) => ({
  data: [makeContainer(overrides)],
  pagination: { current_page: 1, last_page: 1, per_page: 15, total: 1 },
});

const terminalStatus = (overrides: Record<string, unknown> = {}) => ({
  summary: 'ready',
  health: 'healthy',
  observed_at: '2026-09-16T10:00:00+00:00',
  stale: false,
  operation: { state: 'succeeded', terminal: true },
  error: null,
  ...overrides,
});

/** `GET /api/v1/serverless/{id}` — what captureBaseline and each poll read. */
const showResponse = (containerOverrides: Record<string, unknown> = {}, statusOverrides: Record<string, unknown> = {}) => ({
  container: { status_details: terminalStatus(statusOverrides), ...containerOverrides },
  url: null,
});

/**
 * Routes the two shapes update.ts's `--wait` path reads through the SAME
 * `mockGet`: `resolveContainer`'s paginated list call, and captureBaseline
 * plus every poll's singular show call. `showResponses` is consumed in
 * order and the last entry repeats for any further polls, matching
 * `apiReturning` in wait-for-terminal.test.ts.
 */
function mockShowSequence(...showResponses: unknown[]): void {
  let call = 0;
  mockGet.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/serverless?')) return Promise.resolve(listResponse());
    const resp = showResponses[Math.min(call, showResponses.length - 1)];
    call++;
    return Promise.resolve(resp);
  });
}

describe('serverless update command', () => {
  const originalExit = process.exit;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exit = vi.fn().mockImplementation((code: number) => {
      throw new ExitError(code);
    }) as never;
    mockGet.mockReset();
    mockPut.mockReset();
  });

  afterEach(() => {
    process.exit = originalExit;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('updates container image', async () => {
    mockGet.mockResolvedValue(listResponse());
    mockPut.mockResolvedValue({ message: 'Updated', container: makeContainer({ image: 'node' }) });

    await updateCommand.parseAsync(['node', 'test', 'my-api', '--image', 'node', '--tag', '18']);

    expect(mockPut).toHaveBeenCalledWith('/api/v1/serverless/abc-123', { image: 'node', image_tag: '18' });
  });

  it('updates environment variables merged with existing', async () => {
    mockGet.mockResolvedValueOnce(listResponse({
      environment_variables: { EXISTING_KEY: 'existing_value' },
    }));
    mockPut.mockResolvedValue({ message: 'Updated', container: makeContainer() });

    await updateCommand.parseAsync(['node', 'test', 'my-api', '--env', 'NODE_ENV=production', 'PORT=3000']);

    expect(mockPut).toHaveBeenCalledWith('/api/v1/serverless/abc-123', {
      environment_variables: { EXISTING_KEY: 'existing_value', NODE_ENV: 'production', PORT: '3000' },
    });
  });

  it('sets env vars on container with no existing env vars', async () => {
    mockGet.mockResolvedValueOnce(listResponse({ environment_variables: null }));
    mockPut.mockResolvedValue({ message: 'Updated', container: makeContainer() });

    await updateCommand.parseAsync(['node', 'test', 'my-api', '--env', 'KEY=value']);

    expect(mockPut).toHaveBeenCalledWith('/api/v1/serverless/abc-123', {
      environment_variables: { KEY: 'value' },
    });
  });

  it('removes environment variables', async () => {
    mockGet.mockResolvedValueOnce(listResponse({
      environment_variables: { KEEP: 'yes', REMOVE_ME: 'gone', ALSO_REMOVE: 'gone' },
    }));
    mockPut.mockResolvedValue({ message: 'Updated', container: makeContainer() });

    await updateCommand.parseAsync(['node', 'test', 'my-api', '--rm-env', 'REMOVE_ME', 'ALSO_REMOVE']);

    expect(mockPut).toHaveBeenCalledWith('/api/v1/serverless/abc-123', {
      environment_variables: { KEEP: 'yes' },
    });
  });

  it('adds and removes env vars in one command', async () => {
    mockGet.mockResolvedValueOnce(listResponse({
      environment_variables: { OLD: 'value', REPLACE: 'old' },
    }));
    mockPut.mockResolvedValue({ message: 'Updated', container: makeContainer() });

    await updateCommand.parseAsync([
      'node', 'test', 'my-api',
      '--env', 'NEW=added', 'REPLACE=new',
      '--rm-env', 'OLD',
    ]);

    expect(mockPut).toHaveBeenCalledWith('/api/v1/serverless/abc-123', {
      environment_variables: { REPLACE: 'new', NEW: 'added' },
    });
  });

  it('updates scaling options', async () => {
    mockGet.mockResolvedValue(listResponse());
    mockPut.mockResolvedValue({ message: 'Updated', container: makeContainer() });

    await updateCommand.parseAsync([
      'node', 'test', 'my-api',
      '--min-scale', '1',
      '--max-scale', '5',
      '--scaling-metric', 'concurrency',
      '--scaling-target', '50',
      '--concurrency-target', '200',
      '--timeout', '600',
    ]);

    expect(mockPut).toHaveBeenCalledWith('/api/v1/serverless/abc-123', {
      min_scale: 1,
      max_scale: 5,
      scaling_metric: 'concurrency',
      scaling_target: 50,
      concurrency_target: 200,
      timeout_seconds: 600,
    });
  });

  it('updates initial scale and scale-down delay, including zero values', async () => {
    mockGet.mockResolvedValue(listResponse());
    mockPut.mockResolvedValue({ message: 'Updated', container: makeContainer() });

    await updateCommand.parseAsync([
      'node', 'test', 'my-api',
      '--min-scale', '0',
      '--initial-scale', '0',
      '--scale-down-delay', '0',
    ]);

    expect(mockPut).toHaveBeenCalledWith('/api/v1/serverless/abc-123', {
      min_scale: 0,
      initial_scale: 0,
      scale_down_delay_seconds: 0,
    });
  });

  it('accepts a duration suffix for --scale-down-delay', async () => {
    mockGet.mockResolvedValue(listResponse());
    mockPut.mockResolvedValue({ message: 'Updated', container: makeContainer() });

    await updateCommand.parseAsync(['node', 'test', 'my-api', '--scale-down-delay', '30s']);

    expect(mockPut).toHaveBeenCalledWith('/api/v1/serverless/abc-123', { scale_down_delay_seconds: 30 });
  });

  it('rejects an invalid --scale-down-delay instead of guessing', async () => {
    mockGet.mockResolvedValue(listResponse());

    await expect(
      updateCommand.parseAsync(['node', 'test', 'my-api', '--scale-down-delay', 'soon']),
    ).rejects.toThrow('Invalid duration');
  });

  it('exits on non-integer --initial-scale value', async () => {
    mockGet.mockResolvedValueOnce(listResponse());

    await expect(
      updateCommand.parseAsync(['node', 'test', 'my-api', '--initial-scale', 'abc']),
    ).rejects.toThrow(ExitError);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid value for --initial-scale'));
  });

  it('exits on invalid env format (no equals sign)', async () => {
    mockGet.mockResolvedValueOnce(listResponse({ environment_variables: {} }));

    await expect(
      updateCommand.parseAsync(['node', 'test', 'my-api', '--env', 'INVALID_FORMAT']),
    ).rejects.toThrow(ExitError);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid env format'));
  });

  it('exits on non-integer port value', async () => {
    mockGet.mockResolvedValueOnce(listResponse());

    await expect(
      updateCommand.parseAsync(['node', 'test', 'my-api', '--port', 'abc']),
    ).rejects.toThrow(ExitError);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid value for --port'));
  });

  it('exits when no options specified', async () => {
    mockGet.mockResolvedValue(listResponse());

    await expect(
      updateCommand.parseAsync(['node', 'test', 'my-api']),
    ).rejects.toThrow(ExitError);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('No update options'));
  });

  it('outputs the container as JSON in json mode', async () => {
    const { setJsonMode } = await import('../../../src/lib/json-mode.js');
    setJsonMode(true);
    mockGet.mockResolvedValue(listResponse());
    mockPut.mockResolvedValue({ message: 'Updated', container: makeContainer({ image: 'node' }) });

    await updateCommand.parseAsync(['node', 'test', 'my-api', '--image', 'node', '--tag', '18']);

    const printed = JSON.parse(consoleLogSpy.mock.calls.at(-1)![0] as string).data;
    expect(printed).toMatchObject({ image: 'node' });
    setJsonMode(false);
  });

  describe('--wait', () => {
    it('settles once observed_generation reaches the generation the PUT response produced, and reports ready', async () => {
      mockShowSequence(showResponse({ observed_generation: 7, current_revision: 'my-api-00003' }));
      mockPut.mockResolvedValue({ message: 'Updated', container: makeContainer({ spec_generation: 7 }) });

      await updateCommand.parseAsync(['node', 'test', 'my-api', '--image', 'node', '--wait']);

      expect(consoleLogSpy.mock.calls.flat().join('\n')).toContain('Ready');
    });

    it('does not accept a terminal verdict while observed_generation is behind the PUT response generation', async () => {
      vi.useFakeTimers();
      // Baseline capture sees revision r1; every poll after the write reports
      // r2 — fresh evidence by the OLD baseline heuristic — AND terminal:true,
      // but observed_generation stays behind spec_generation. If update.ts
      // failed to wire minGeneration through, the baseline heuristic alone
      // would accept this on the very first poll after the write.
      mockShowSequence(
        showResponse({ current_revision: 'my-api-r1', deployment_count: 1 }),
        showResponse({ current_revision: 'my-api-r2', deployment_count: 2, observed_generation: 4 }),
      );
      mockPut.mockResolvedValue({ message: 'Updated', container: makeContainer({ spec_generation: 7 }) });

      const promise = updateCommand.parseAsync([
        'node', 'test', 'my-api', '--image', 'node', '--wait', '--wait-timeout', '5s',
      ]);
      await vi.advanceTimersByTimeAsync(10_000);
      await promise;
      vi.useRealTimers();

      // Not settled: sawFreshObservation never went true, since the gate in
      // this mode is the generation, not the baseline signals that changed.
      expect(consoleErrorSpy.mock.calls.flat().join('\n')).toContain(
        'Timed out before the platform re-observed this container',
      );
    });

    it('without --wait, makes no extra GETs beyond resolving the container', async () => {
      mockGet.mockResolvedValue(listResponse());
      mockPut.mockResolvedValue({ message: 'Updated', container: makeContainer({ spec_generation: 3 }) });

      await updateCommand.parseAsync(['node', 'test', 'my-api', '--image', 'node']);

      // Today's behaviour is exactly one GET: resolveContainer's list call.
      // captureBaseline must not run when --wait was not requested.
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('exits 1 on a settled failure, same rule as apply/create --wait', async () => {
      mockShowSequence(showResponse(
        { observed_generation: 9 },
        { summary: 'failed', health: 'unhealthy', operation: { state: 'failed', terminal: true } },
      ));
      mockPut.mockResolvedValue({ message: 'Updated', container: makeContainer({ spec_generation: 9 }) });

      await updateCommand.parseAsync(['node', 'test', 'my-api', '--image', 'node', '--wait']);

      expect(process.exitCode).toBe(1);
    });
  });
});
