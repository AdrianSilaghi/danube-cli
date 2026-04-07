import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet }),
  },
}));

const { lsCommand } = await import('../../../src/commands/serverless/ls.js');

const makeContainer = (overrides = {}) => ({
  id: 'abc-123', name: 'my-api', slug: 'my-api', deployment_type: 'docker_image',
  source_type: null, image: 'nginx', image_tag: 'latest', port: 8080,
  resource_profile: 'basic', min_scale: 0, max_scale: 10, status: 'running',
  url: 'https://my-api.serverless.danubedata.ro', created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('serverless ls command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGet.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows message when no containers', async () => {
    mockGet.mockResolvedValue({ data: [], pagination: { current_page: 1, last_page: 1, per_page: 15, total: 0 } });

    await lsCommand.parseAsync(['node', 'test']);

    expect(consoleLogSpy).toHaveBeenCalledWith('No serverless containers found.');
  });

  it('displays containers table', async () => {
    mockGet.mockResolvedValue({
      data: [makeContainer(), makeContainer({ name: 'worker', status: 'stopped' })],
      pagination: { current_page: 1, last_page: 1, per_page: 15, total: 2 },
    });

    await lsCommand.parseAsync(['node', 'test']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('NAME'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('my-api'));
  });
});
