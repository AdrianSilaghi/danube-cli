import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet }),
  },
}));

const { deploymentsCommand } = await import('../../../src/commands/serverless/deployments.js');

const makeContainer = (overrides = {}) => ({
  id: 'abc-123', name: 'my-api', slug: 'my-api', deployment_type: 'docker_image',
  source_type: null, image: 'nginx', image_tag: 'latest', port: 8080,
  resource_profile: 'basic', min_scale: 0, max_scale: 10, status: 'running',
  url: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('serverless deployments command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGet.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows message when no deployments', async () => {
    mockGet
      .mockResolvedValueOnce({
        data: [makeContainer()],
        pagination: { current_page: 1, last_page: 1, per_page: 15, total: 1 },
      })
      .mockResolvedValueOnce({
        data: [],
        pagination: { current_page: 1, last_page: 1, per_page: 15, total: 0 },
      });

    await deploymentsCommand.parseAsync(['node', 'test', 'my-api']);

    expect(consoleLogSpy).toHaveBeenCalledWith('No deployments yet.');
  });

  it('displays deployments table', async () => {
    mockGet
      .mockResolvedValueOnce({
        data: [makeContainer()],
        pagination: { current_page: 1, last_page: 1, per_page: 15, total: 1 },
      })
      .mockResolvedValueOnce({
        data: [{
          id: 'd-1', revision_number: 1, status: 'active', is_current: true,
          image: 'nginx', image_tag: 'latest', traffic_percent: 100,
          deployed_at: '2024-01-01T00:00:00Z', created_at: '2024-01-01T00:00:00Z',
        }],
        pagination: { current_page: 1, last_page: 1, per_page: 15, total: 1 },
      });

    await deploymentsCommand.parseAsync(['node', 'test', 'my-api']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('REVISION'));
  });
});
