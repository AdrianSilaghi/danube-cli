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

describe('serverless update command', () => {
  const originalExit = process.exit;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exit = vi.fn().mockImplementation((code: number) => {
      throw new ExitError(code);
    }) as never;
    mockGet.mockReset();
    mockPut.mockReset();
  });

  afterEach(() => {
    process.exit = originalExit;
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
});
