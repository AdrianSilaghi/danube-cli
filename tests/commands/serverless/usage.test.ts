import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet }),
  },
}));

const { usageCommand } = await import('../../../src/commands/serverless/usage.js');

const makeContainer = (overrides = {}) => ({
  id: 'abc-123', name: 'my-api', slug: 'my-api', deployment_type: 'docker_image',
  source_type: null, image: 'nginx', image_tag: 'latest', port: 8080,
  resource_profile: 'basic', min_scale: 0, max_scale: 10, status: 'running',
  url: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('serverless usage command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGet.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows usage summary', async () => {
    mockGet
      .mockResolvedValueOnce({
        data: [makeContainer()],
        pagination: { current_page: 1, last_page: 1, per_page: 15, total: 1 },
      })
      .mockResolvedValueOnce({
        period: '2024-01',
        usage: [],
        summary: {
          total_requests: 15000,
          total_compute_seconds: 3600,
          total_cost_cents: 499,
          total_cost_dollars: 4.99,
        },
      });

    await usageCommand.parseAsync(['node', 'test', 'my-api']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('my-api'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('15,000'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('4.99'));
  });

  it('passes period option', async () => {
    mockGet
      .mockResolvedValueOnce({
        data: [makeContainer()],
        pagination: { current_page: 1, last_page: 1, per_page: 15, total: 1 },
      })
      .mockResolvedValueOnce({
        period: '2024-06',
        usage: [],
        summary: { total_requests: 0, total_compute_seconds: 0, total_cost_cents: 0, total_cost_dollars: 0 },
      });

    await usageCommand.parseAsync(['node', 'test', 'my-api', '--period', '2024-06']);

    expect(mockGet).toHaveBeenCalledWith('/api/v1/serverless/abc-123/usage?period=2024-06');
  });
});
