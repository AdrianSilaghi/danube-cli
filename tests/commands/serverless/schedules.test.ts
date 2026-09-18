import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPatch = vi.fn();
const mockDelete = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet, post: mockPost, patch: mockPatch, delete: mockDelete }),
  },
}));

const { lsCommand, showCommand, createCommand, rmCommand, pauseCommand, resumeCommand } =
  await import('../../../src/commands/serverless/schedules.js');
const { setJsonMode } = await import('../../../src/lib/json-mode.js');

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

const makeSchedule = (overrides: Record<string, unknown> = {}) => ({
  id: 'sch-1', name: 'nightly-migrate', cron_expression: '0 3 * * *',
  timezone: 'Europe/Bucharest', command: ['php', 'artisan', 'migrate', '--force'],
  image_tag: null, timeout_seconds: 900, enabled: true,
  next_run_at: '2026-09-19T00:00:00Z', last_run_at: null,
  last_skipped_at: null, last_skip_reason: null,
  created_at: '2026-09-18T00:00:00Z', updated_at: '2026-09-18T00:00:00Z',
  ...overrides,
});

describe('rapids schedules', () => {
  const originalExit = process.exit;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.exit = vi.fn().mockImplementation((code: number) => {
      throw new ExitError(code);
    }) as never;
    mockGet.mockReset();
    mockPost.mockReset();
    mockPatch.mockReset();
    mockDelete.mockReset();
  });

  afterEach(() => {
    process.exit = originalExit;
    process.exitCode = undefined;
    setJsonMode(false);
    vi.restoreAllMocks();
  });

  const listSchedules = (schedules: unknown[]) =>
    mockGet.mockImplementation((path: string) =>
      Promise.resolve(isListCall(path) ? listResponse() : { data: schedules }));

  describe('ls', () => {
    it('prints a table of schedules', async () => {
      listSchedules([makeSchedule()]);

      await lsCommand.parseAsync(['node', 'test', 'my-api']);

      const out = logSpy.mock.calls.flat().join('\n');
      expect(out).toContain('nightly-migrate');
      expect(out).toContain('0 3 * * *');
      expect(out).toContain('Europe/Bucharest');
    });

    it('reports no schedules yet', async () => {
      listSchedules([]);

      await lsCommand.parseAsync(['node', 'test', 'my-api']);

      expect(logSpy.mock.calls.flat().join('\n')).toContain('No schedules yet.');
    });
  });

  describe('create', () => {
    it('sends the repeat rule and command, and never an env', async () => {
      mockGet.mockImplementation(() => Promise.resolve(listResponse()));
      mockPost.mockResolvedValue({ data: makeSchedule() });

      await createCommand.parseAsync([
        'node', 'test', 'my-api', 'php', 'artisan', 'migrate',
        '--name', 'nightly-migrate', '--cron', '0 3 * * *', '--timezone', 'Europe/Bucharest',
      ]);

      const [path, body] = mockPost.mock.calls[0];
      expect(path).toBe('/api/v1/serverless/c-1/schedules');
      expect(body).toMatchObject({
        name: 'nightly-migrate',
        cron_expression: '0 3 * * *',
        timezone: 'Europe/Bucharest',
        command: ['php', 'artisan', 'migrate'],
        timeout_seconds: 900,
      });
      // A schedule is stored, so override values are never part of it.
      expect(body).not.toHaveProperty('env');
    });

    it('omits the command so the image entrypoint is used', async () => {
      mockGet.mockImplementation(() => Promise.resolve(listResponse()));
      mockPost.mockResolvedValue({ data: makeSchedule({ command: null }) });

      await createCommand.parseAsync(['node', 'test', 'my-api', '--name', 'hourly', '--cron', '0 * * * *']);

      expect(mockPost.mock.calls[0][1]).not.toHaveProperty('command');
    });
  });

  describe('show', () => {
    it('finds a schedule by name and surfaces why an occurrence was skipped', async () => {
      listSchedules([makeSchedule({
        last_skipped_at: '2026-09-18T00:00:00Z',
        last_skip_reason: 'The previous run was still going when this one came due.',
      })]);

      await showCommand.parseAsync(['node', 'test', 'my-api', 'nightly-migrate']);

      const out = logSpy.mock.calls.flat().join('\n');
      expect(out).toContain('still going');
    });

    it('reports a name that does not exist rather than letting a 404 read as "not enabled"', async () => {
      listSchedules([makeSchedule()]);

      await expect(
        showCommand.parseAsync(['node', 'test', 'my-api', 'no-such-schedule']),
      ).rejects.toThrow(ExitError);

      expect(errSpy.mock.calls.flat().join('\n')).toContain("No schedule named 'no-such-schedule'");
    });
  });

  describe('rm', () => {
    it('deletes by the resolved id, not the name typed', async () => {
      listSchedules([makeSchedule()]);
      mockDelete.mockResolvedValue({ data: null });

      await rmCommand.parseAsync(['node', 'test', 'my-api', 'nightly-migrate']);

      expect(mockDelete).toHaveBeenCalledWith('/api/v1/serverless/c-1/schedules/sch-1');
    });
  });

  describe('pause and resume', () => {
    it('pauses without deleting', async () => {
      listSchedules([makeSchedule()]);
      mockPatch.mockResolvedValue({ data: makeSchedule({ enabled: false }) });

      await pauseCommand.parseAsync(['node', 'test', 'my-api', 'nightly-migrate']);

      expect(mockPatch).toHaveBeenCalledWith('/api/v1/serverless/c-1/schedules/sch-1', { enabled: false });
      expect(logSpy.mock.calls.flat().join('\n')).toContain('paused');
    });

    it('reports when the resumed schedule next runs', async () => {
      listSchedules([makeSchedule({ enabled: false })]);
      mockPatch.mockResolvedValue({ data: makeSchedule({ enabled: true }) });

      await resumeCommand.parseAsync(['node', 'test', 'my-api', 'nightly-migrate']);

      expect(mockPatch).toHaveBeenCalledWith('/api/v1/serverless/c-1/schedules/sch-1', { enabled: true });
      expect(logSpy.mock.calls.flat().join('\n')).toContain('Next run');
    });
  });

  describe('json mode', () => {
    it('emits the schedule as json', async () => {
      setJsonMode(true);
      listSchedules([makeSchedule()]);

      await showCommand.parseAsync(['node', 'test', 'my-api', 'nightly-migrate']);

      const payload = JSON.parse(logSpy.mock.calls.at(-1)![0] as string);
      expect(payload.data.name).toBe('nightly-migrate');
    });
  });
});
