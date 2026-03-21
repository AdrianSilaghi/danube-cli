import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet }),
  },
}));

const { showCommand } = await import('../../../src/commands/serverless/show.js');

const makeContainer = (overrides = {}) => ({
  id: 'abc-123', name: 'my-api', slug: 'my-api', deployment_type: 'docker_image',
  source_type: null, image: 'nginx', image_tag: 'latest', port: 8080,
  resource_profile: 'basic', min_scale: 0, max_scale: 10, status: 'running',
  scaling_metric: 'rps', scaling_target: 100, concurrency_target: 100,
  timeout_seconds: 300, environment_variables: null, current_replicas: 2,
  url: 'https://my-api.serverless.danubedata.ro', created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('serverless show command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGet.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows container details with scaling info', async () => {
    // First call: resolve container (ls)
    mockGet.mockResolvedValueOnce({
      data: [makeContainer()],
      pagination: { current_page: 1, last_page: 1, per_page: 15, total: 1 },
    });
    // Second call: show details
    mockGet.mockResolvedValueOnce({
      container: makeContainer(),
      metrics: {},
      url: 'https://my-api.serverless.danubedata.ro',
      monthly_cost: 9.99,
    });

    await showCommand.parseAsync(['node', 'test', 'my-api']);

    const allOutput = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    expect(allOutput).toContain('my-api');
    expect(allOutput).toContain('9.99');
    expect(allOutput).toContain('Scaling');
    expect(allOutput).toContain('Min Replicas');
    expect(allOutput).toContain('Max Replicas');
    expect(allOutput).toContain('Current');
  });

  it('shows environment variables', async () => {
    mockGet.mockResolvedValueOnce({
      data: [makeContainer({ environment_variables: { NODE_ENV: 'production', SECRET: 'supersecretvalue' } })],
      pagination: { current_page: 1, last_page: 1, per_page: 15, total: 1 },
    });
    mockGet.mockResolvedValueOnce({
      container: makeContainer({ environment_variables: { NODE_ENV: 'production', SECRET: 'supersecretvalue' } }),
      metrics: {},
      url: null,
      monthly_cost: 4.99,
    });

    await showCommand.parseAsync(['node', 'test', 'my-api']);

    const allOutput = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    expect(allOutput).toContain('Environment Variables');
    expect(allOutput).toContain('NODE_ENV=[hidden]');
    expect(allOutput).toContain('SECRET=[hidden]');
  });

  it('throws when container not found', async () => {
    mockGet.mockResolvedValue({ data: [], pagination: { current_page: 1, last_page: 1, per_page: 15, total: 0 } });

    await expect(showCommand.parseAsync(['node', 'test', 'nonexistent'])).rejects.toThrow("Container 'nonexistent' not found.");
  });
});
