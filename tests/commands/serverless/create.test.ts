import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet, post: mockPost }),
  },
}));

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn().mockResolvedValue('docker_image'),
  input: vi.fn().mockResolvedValue('test-value'),
}));

const { createCommand } = await import('../../../src/commands/serverless/create.js');

describe('serverless create command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGet.mockReset();
    mockPost.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates container with all flags', async () => {
    mockGet.mockResolvedValue({
      data: [{ id: 1, name: 'My Team', personal_team: true }],
      current_team_id: 1,
    });
    mockPost.mockResolvedValue({
      message: 'Created',
      container: {
        id: 'abc-123', name: 'my-api', status: 'pending',
        slug: 'my-api', deployment_type: 'docker_image',
      },
    });

    await createCommand.parseAsync([
      'node', 'test',
      '--name', 'my-api',
      '--type', 'docker_image',
      '--image', 'nginx',
      '--tag', 'latest',
      '--profile', 'basic',
      '--port', '3000',
    ]);

    expect(mockPost).toHaveBeenCalledWith('/api/v1/serverless', expect.objectContaining({
      name: 'my-api',
      deployment_type: 'docker_image',
      image: 'nginx',
      image_tag: 'latest',
      resource_profile: 'basic',
      port: 3000,
    }));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Created'));
  });
});
