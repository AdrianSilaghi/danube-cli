import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet, post: mockPost }),
  },
}));

const mockSelect = vi.fn().mockResolvedValue('docker_image');
vi.mock('@inquirer/prompts', () => ({
  select: (...args: unknown[]) => mockSelect(...args),
  input: vi.fn().mockResolvedValue('test-value'),
}));

const { createCommand } = await import('../../../src/commands/serverless/create.js');

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

const teamsResponse = (teams = [{ id: 1, name: 'My Team', personal_team: true }]) => ({
  data: teams,
  current_team_id: teams[0]!.id,
});

const containerResponse = (overrides = {}) => ({
  message: 'Created',
  container: {
    id: 'abc-123', name: 'my-api', status: 'pending',
    slug: 'my-api', deployment_type: 'docker_image',
    ...overrides,
  },
});

describe('serverless create command', () => {
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
    mockPost.mockReset();
    mockSelect.mockReset().mockResolvedValue('docker_image');
  });

  afterEach(() => {
    process.exit = originalExit;
    vi.restoreAllMocks();
  });

  it('creates docker_image container with all flags and sends team_id', async () => {
    mockGet.mockResolvedValue(teamsResponse());
    mockPost.mockResolvedValue(containerResponse());

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
      team_id: 1,
      name: 'my-api',
      deployment_type: 'docker_image',
      image: 'nginx',
      image_tag: 'latest',
      resource_profile: 'basic',
      port: 3000,
    }));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Created'));
  });

  it('creates git_repository container with --repo and --source-type', async () => {
    mockGet.mockResolvedValue(teamsResponse());
    mockPost.mockResolvedValue(containerResponse({ deployment_type: 'git_repository' }));

    await createCommand.parseAsync([
      'node', 'test',
      '--name', 'my-repo-app',
      '--type', 'git_repository',
      '--repo', 'https://github.com/user/repo.git',
      '--source-type', 'dockerfile',
      '--profile', 'small',
    ]);

    expect(mockPost).toHaveBeenCalledWith('/api/v1/serverless', expect.objectContaining({
      team_id: 1,
      name: 'my-repo-app',
      deployment_type: 'git_repository',
      repository_url: 'https://github.com/user/repo.git',
      source_type: 'dockerfile',
      git_auth_type: 'none',
      resource_profile: 'small',
      port: 8080,
    }));
  });

  it('creates zip_upload container via --type local alias', async () => {
    mockGet.mockResolvedValue(teamsResponse());
    mockPost.mockResolvedValue(containerResponse({ deployment_type: 'zip_upload' }));
    mockSelect.mockResolvedValue('buildpack');

    await createCommand.parseAsync([
      'node', 'test',
      '--name', 'my-zip-app',
      '--type', 'local',
      '--source-type', 'buildpack',
      '--profile', 'micro',
    ]);

    expect(mockPost).toHaveBeenCalledWith('/api/v1/serverless', expect.objectContaining({
      team_id: 1,
      name: 'my-zip-app',
      deployment_type: 'zip_upload',
      source_type: 'buildpack',
      resource_profile: 'micro',
    }));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('danube rapids deploy'));
  });

  it('prompts for team selection when multiple teams exist', async () => {
    const teams = [
      { id: 1, name: 'Team Alpha', personal_team: true },
      { id: 2, name: 'Team Beta', personal_team: false },
    ];
    mockGet.mockResolvedValue(teamsResponse(teams));
    mockPost.mockResolvedValue(containerResponse());
    mockSelect
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce('docker_image');

    await createCommand.parseAsync([
      'node', 'test',
      '--name', 'multi-team-app',
      '--type', 'docker_image',
      '--image', 'node',
      '--tag', '20',
      '--profile', 'medium',
    ]);

    expect(mockPost).toHaveBeenCalledWith('/api/v1/serverless', expect.objectContaining({
      team_id: 2,
      name: 'multi-team-app',
    }));
  });

  it('exits with error for non-numeric --port value', async () => {
    mockGet.mockResolvedValue(teamsResponse());

    await expect(
      createCommand.parseAsync([
        'node', 'test',
        '--name', 'bad-port',
        '--type', 'docker_image',
        '--image', 'nginx',
        '--tag', 'latest',
        '--profile', 'basic',
        '--port', 'abc',
      ]),
    ).rejects.toThrow(ExitError);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid value for port"));
  });
});
