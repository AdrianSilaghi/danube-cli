import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPut = vi.fn();
const mockPost = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet, put: mockPut, post: mockPost }),
  },
}));

const { applyCommand, slugify } = await import('../../../src/commands/serverless/apply.js');

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

const makeContainer = (overrides: Record<string, unknown> = {}) => ({
  id: 'abc-123', name: 'my-api', slug: 'my-api', deployment_type: 'docker_image',
  source_type: null, image: 'nginx', image_tag: 'latest', port: 8080,
  resource_profile: 'basic', min_scale: 0, max_scale: 10, status: 'running',
  scaling_metric: null, scaling_target: null, concurrency_target: null,
  timeout_seconds: null, environment_variables: null, current_replicas: 1,
  url: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

/**
 * Routes both shapes apply.ts's `api.get` calls read through the SAME mock:
 * `findByName`'s bare-path list call, and captureBaseline's `/{id}` show
 * call (issued whenever there is drift, `--wait` or not). Without this, a
 * blanket `mockResolvedValue` hands captureBaseline the list shape and it
 * throws reading `.container` off it.
 */
function mockExisting(container: Record<string, unknown>): void {
  mockGet.mockImplementation((path: string) =>
    path === '/api/v1/serverless'
      ? Promise.resolve({ data: [container] })
      : Promise.resolve({ container, url: null }),
  );
}

describe('apply slugify', () => {
  it('mirrors the API slug rule', () => {
    expect(slugify('My API')).toBe('my-api');
    expect(slugify('Danube Todo')).toBe('danube-todo');
  });

  it('collapses runs of non-alphanumerics into one hyphen', () => {
    expect(slugify('a  b__c!!d')).toBe('a-b-c-d');
  });

  it('does not emit leading or trailing hyphens', () => {
    // The API regex is ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ — a leading or trailing
    // hyphen is rejected, so producing one would turn a valid name into a 422.
    expect(slugify('  spaced  ')).toBe('spaced');
    expect(slugify('!!weird!!')).toBe('weird');
  });

  it('truncates to the 63-character limit', () => {
    expect(slugify('a'.repeat(100))).toHaveLength(63);
  });
});

describe('apply --env/--rm-env', () => {
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
    mockPost.mockReset();
  });

  afterEach(() => {
    process.exit = originalExit;
    vi.restoreAllMocks();
  });

  it('merges --env on top of the existing map and PUTs only environment_variables', async () => {
    mockExisting(makeContainer({ environment_variables: { A: '1' } }));
    mockPut.mockResolvedValue({ message: 'Updated', container: makeContainer({ environment_variables: { A: '1', B: '2' } }) });

    await applyCommand.parseAsync(['node', 'test', '--name', 'my-api', '--env', 'B=2']);

    expect(mockPut).toHaveBeenCalledWith('/api/v1/serverless/abc-123', {
      environment_variables: { A: '1', B: '2' },
    });
  });

  it('removes keys named by --rm-env before merging --env', async () => {
    mockExisting(makeContainer({ environment_variables: { KEEP: 'yes', DROP: 'gone' } }));
    mockPut.mockResolvedValue({ message: 'Updated', container: makeContainer() });

    await applyCommand.parseAsync(['node', 'test', '--name', 'my-api', '--rm-env', 'DROP']);

    expect(mockPut).toHaveBeenCalledWith('/api/v1/serverless/abc-123', {
      environment_variables: { KEEP: 'yes' },
    });
  });

  it('treats env as an order-insensitive map: resubmitting the same pairs is unchanged (no PUT)', async () => {
    mockExisting(makeContainer({ environment_variables: { A: '1', B: '2' } }));

    await applyCommand.parseAsync(['node', 'test', '--name', 'my-api', '--env', 'B=2', 'A=1']);

    expect(mockPut).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('unchanged'));
  });

  it('a scalar-only change does not send environment_variables', async () => {
    mockExisting(makeContainer({ environment_variables: { A: '1' } }));
    mockPut.mockResolvedValue({ message: 'Updated', container: makeContainer({ image: 'node' }) });

    await applyCommand.parseAsync(['node', 'test', '--name', 'my-api', '--image', 'node']);

    expect(mockPut).toHaveBeenCalledWith('/api/v1/serverless/abc-123', { image: 'node' });
  });

  it('on create, sets environment_variables to the --env pairs and --rm-env is a no-op', async () => {
    mockGet.mockResolvedValue({ data: [] }); // no container named my-api exists yet
    mockPost.mockResolvedValue({ message: 'Created', container: makeContainer({ environment_variables: { A: '1' } }) });

    await applyCommand.parseAsync(['node', 'test', '--name', 'my-api', '--env', 'A=1', '--rm-env', 'UNRELATED']);

    expect(mockPost).toHaveBeenCalledWith(
      '/api/v1/serverless',
      expect.objectContaining({ environment_variables: { A: '1' } }),
      undefined,
    );
  });

  it('on create, --rm-env alone (no --env) never sends environment_variables', async () => {
    mockGet.mockResolvedValue({ data: [] });
    mockPost.mockResolvedValue({ message: 'Created', container: makeContainer() });

    await applyCommand.parseAsync(['node', 'test', '--name', 'my-api', '--rm-env', 'UNRELATED']);

    const body = mockPost.mock.calls[0]![1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('environment_variables');
  });

  it('exits on invalid --env format (no equals sign)', async () => {
    mockGet.mockResolvedValue({ data: [] });

    await expect(
      applyCommand.parseAsync(['node', 'test', '--name', 'my-api', '--env', 'INVALID']),
    ).rejects.toThrow(ExitError);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid env format'));
  });
});
