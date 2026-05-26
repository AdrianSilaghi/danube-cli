import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet, post: mockPost }),
  },
}));

vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  }),
}));

const { redeployCommand } = await import('../../../src/commands/serverless/redeploy.js');

const makeContainer = (overrides = {}) => ({
  id: 'abc-123', name: 'my-api', slug: 'my-api', deployment_type: 'docker_image',
  source_type: null, image: 'nginx', image_tag: 'latest', port: 8080,
  resource_profile: 'basic', min_scale: 0, max_scale: 10, status: 'running',
  url: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('serverless redeploy command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGet.mockReset();
    mockPost.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redeploys a container resolved by name', async () => {
    mockGet.mockResolvedValue({
      data: [makeContainer()],
      pagination: { current_page: 1, last_page: 1, per_page: 15, total: 1 },
    });
    mockPost.mockResolvedValue({
      message: 'Redeployment initiated. A new revision will be created with the latest image.',
      container_id: 'abc-123',
      status: 'provisioning',
    });

    await redeployCommand.parseAsync(['node', 'test', 'my-api']);

    expect(mockPost).toHaveBeenCalledWith('/api/v1/serverless/abc-123/redeploy');
  });

  it('throws when container not found', async () => {
    mockGet.mockResolvedValue({ data: [], pagination: { current_page: 1, last_page: 1, per_page: 15, total: 0 } });

    await expect(redeployCommand.parseAsync(['node', 'test', 'nonexistent'])).rejects.toThrow("Container 'nonexistent' not found.");
  });
});
