import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockDelete = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet, delete: mockDelete }),
  },
}));

vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  }),
}));

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

const { rmCommand } = await import('../../../src/commands/serverless/rm.js');

const makeContainer = (overrides = {}) => ({
  id: 'abc-123', name: 'my-api', slug: 'my-api', deployment_type: 'docker_image',
  source_type: null, image: 'nginx', image_tag: 'latest', port: 8080,
  resource_profile: 'basic', min_scale: 0, max_scale: 10, status: 'running',
  url: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('serverless rm command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGet.mockReset();
    mockDelete.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('deletes container with --yes flag', async () => {
    mockGet.mockResolvedValue({
      data: [makeContainer()],
      pagination: { current_page: 1, last_page: 1, per_page: 15, total: 1 },
    });
    mockDelete.mockResolvedValue({ message: 'Deleted' });

    await rmCommand.parseAsync(['node', 'test', 'my-api', '--yes']);

    expect(mockDelete).toHaveBeenCalledWith('/api/v1/serverless/abc-123');
  });

  it('throws when container not found', async () => {
    mockGet.mockResolvedValue({ data: [], pagination: { current_page: 1, last_page: 1, per_page: 15, total: 0 } });

    await expect(rmCommand.parseAsync(['node', 'test', 'nonexistent', '--yes'])).rejects.toThrow("Container 'nonexistent' not found.");
  });
});
