import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('sends the container’s environment_snapshot with the merged environment', async () => {
    mockExisting(makeContainer({ environment_variables: { A: '1' }, environment_snapshot: 'snap-1' }));
    mockPut.mockResolvedValue({ message: 'Updated', container: makeContainer() });

    await applyCommand.parseAsync(['node', 'test', '--name', 'my-api', '--env', 'B=2']);

    expect(mockPut).toHaveBeenCalledWith('/api/v1/serverless/abc-123', {
      environment_variables: { A: '1', B: '2' },
      environment_snapshot: 'snap-1',
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

  it('creates with secret_environment_variables, sending only the secrets that carry a value', async () => {
    mockGet.mockResolvedValue({ data: [] });
    mockPost.mockResolvedValue({ message: 'Created', container: makeContainer({ secret_environment_keys: ['API_KEY'] }) });

    await applyCommand.parseAsync(['node', 'test', '--name', 'my-api', '--secret', 'API_KEY=abc', '--rm-secret', 'GONE']);

    expect(mockPost).toHaveBeenCalledWith(
      '/api/v1/serverless',
      expect.objectContaining({ secret_environment_variables: { API_KEY: 'abc' } }),
      undefined,
    );
  });

  it('updates secrets alone, with the snapshot, and reports updated', async () => {
    mockExisting(makeContainer({ environment_snapshot: 'snap-1', secret_environment_keys: ['OLD'] }));
    mockPut.mockResolvedValue({ message: 'Updated', container: makeContainer() });

    await applyCommand.parseAsync(['node', 'test', '--name', 'my-api', '--secret', 'API_KEY=abc', '--rm-secret', 'OLD']);

    expect(mockPut).toHaveBeenCalledWith('/api/v1/serverless/abc-123', {
      secret_environment_variables: { API_KEY: 'abc', OLD: null },
      environment_snapshot: 'snap-1',
    });
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('updated'));
  });

  it('treats removing a secret the container does not hold as unchanged', async () => {
    mockExisting(makeContainer({ secret_environment_keys: ['KEEP'] }));

    await applyCommand.parseAsync(['node', 'test', '--name', 'my-api', '--rm-secret', 'NOT_THERE']);

    expect(mockPut).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('unchanged'));
  });

  it('fails loudly when a created container comes back without the secrets that were sent', async () => {
    mockGet.mockResolvedValue({ data: [] });
    mockPost.mockResolvedValue({ message: 'Created', container: makeContainer() });

    await expect(
      applyCommand.parseAsync(['node', 'test', '--name', 'my-api', '--secret', 'API_KEY=abc']),
    ).rejects.toThrow(/was created WITHOUT its secret variables.*does not support secret variables yet/);
  });

  it('refuses an update with secrets before writing when the platform does not report secret keys', async () => {
    const container = makeContainer({ environment_variables: { DB_PASSWORD: 'x' } });
    mockExisting(container);

    await expect(
      applyCommand.parseAsync(['node', 'test', '--name', 'my-api', '--rm-env', 'DB_PASSWORD', '--secret', 'DB_PASSWORD=hunter2']),
    ).rejects.toThrow(/does not support secret variables yet, so nothing was changed/);

    expect(mockPut).not.toHaveBeenCalled();
  });

  it('moves a plain variable to a secret in the same write', async () => {
    mockExisting(makeContainer({ environment_variables: { DB_PASSWORD: 'old' }, secret_environment_keys: [] }));
    mockPut.mockResolvedValue({ message: 'Updated', container: makeContainer({ spec_generation: 2 }) });

    await applyCommand.parseAsync(['node', 'test', '--name', 'my-api', '--secret', 'DB_PASSWORD=new']);

    expect(mockPut).toHaveBeenCalledWith('/api/v1/serverless/abc-123', {
      environment_variables: {},
      secret_environment_variables: { DB_PASSWORD: 'new' },
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.anything());
  });

  it('reports unchanged when the platform did not move the generation', async () => {
    mockExisting(makeContainer({ spec_generation: 6, secret_environment_keys: ['K'] }));
    mockPut.mockResolvedValue({ message: 'Updated', container: makeContainer({ spec_generation: 6 }) });

    await applyCommand.parseAsync(['node', 'test', '--name', 'my-api', '--secret', 'K=same', '--wait']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('unchanged'));
  });

  it('creates with environment_variables from --env-file', async () => {
    mockGet.mockResolvedValue({ data: [] });
    mockPost.mockResolvedValue({ message: 'Created', container: makeContainer() });
    const dir = await mkdtemp(join(tmpdir(), 'danube-apply-env-'));
    await writeFile(join(dir, '.env'), 'A=1\n');

    try {
      await applyCommand.parseAsync(['node', 'test', '--name', 'my-api', '--env-file', join(dir, '.env')]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(mockPost).toHaveBeenCalledWith(
      '/api/v1/serverless',
      expect.objectContaining({ environment_variables: { A: '1' } }),
      undefined,
    );
  });

  it('refuses an --env KEY that is not in the environment, before any request', async () => {
    await expect(
      applyCommand.parseAsync(['node', 'test', '--name', 'my-api', '--env', 'DANUBE_TEST_SURELY_UNSET']),
    ).rejects.toThrow(/Invalid env format: --env argument 1/);

    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe('apply --initial-scale/--scale-down-delay', () => {
  const originalExit = process.exit;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
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

  it('drift comparison includes initial_scale and scale_down_delay_seconds', async () => {
    mockExisting(makeContainer({ initial_scale: null, scale_down_delay_seconds: null }));
    mockPut.mockResolvedValue({
      message: 'Updated',
      container: makeContainer({ initial_scale: 0, scale_down_delay_seconds: 0 }),
    });

    await applyCommand.parseAsync([
      'node', 'test', '--name', 'my-api', '--min-scale', '0', '--initial-scale', '0', '--scale-down-delay', '0',
    ]);

    expect(mockPut).toHaveBeenCalledWith('/api/v1/serverless/abc-123', expect.objectContaining({
      initial_scale: 0,
      scale_down_delay_seconds: 0,
    }));
  });

  it('resubmitting the same initial_scale/scale_down_delay_seconds is unchanged (no PUT)', async () => {
    mockExisting(makeContainer({ initial_scale: 0, scale_down_delay_seconds: 0 }));

    await applyCommand.parseAsync([
      'node', 'test', '--name', 'my-api', '--initial-scale', '0', '--scale-down-delay', '0',
    ]);

    expect(mockPut).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('unchanged'));
  });

  it('on create, sends both fields when supplied', async () => {
    mockGet.mockResolvedValue({ data: [] });
    mockPost.mockResolvedValue({
      message: 'Created',
      container: makeContainer({ initial_scale: 1, scale_down_delay_seconds: 60 }),
    });

    await applyCommand.parseAsync([
      'node', 'test', '--name', 'my-api', '--initial-scale', '1', '--scale-down-delay', '1m',
    ]);

    expect(mockPost).toHaveBeenCalledWith(
      '/api/v1/serverless',
      expect.objectContaining({ initial_scale: 1, scale_down_delay_seconds: 60 }),
      undefined,
    );
  });
});
