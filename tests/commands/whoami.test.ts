import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
vi.mock('../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet }),
  },
}));

const { whoamiCommand } = await import('../../src/commands/whoami.js');

describe('whoami command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGet.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('displays user and team info', async () => {
    mockGet
      .mockResolvedValueOnce({ id: 1, name: 'Alice', email: 'alice@test.com' })
      .mockResolvedValueOnce({ data: [{ id: 1, name: 'Team A' }, { id: 2, name: 'Team B' }] });

    await whoamiCommand.parseAsync(['node', 'test']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Alice'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('alice@test.com'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Team A, Team B'));
  });

  it('says which project a locked token works in', async () => {
    mockGet
      .mockResolvedValueOnce({ id: 1, name: 'Alice', email: 'alice@test.com' })
      .mockResolvedValueOnce({ data: [{ id: 1, name: 'Team A' }, { id: 2, name: 'Team B' }], current_team_id: 2, token_team_id: 2 });

    await whoamiCommand.parseAsync(['node', 'test']);

    expect(consoleLogSpy).toHaveBeenCalledWith('Token works in: Team B (id 2) only');
  });

  it('says an account-wide token works in every project', async () => {
    mockGet
      .mockResolvedValueOnce({ id: 1, name: 'Alice', email: 'alice@test.com' })
      .mockResolvedValueOnce({ data: [{ id: 1, name: 'Team A' }], current_team_id: 1, token_team_id: null });

    await whoamiCommand.parseAsync(['node', 'test']);

    expect(consoleLogSpy).toHaveBeenCalledWith('Token works in: all your projects');
  });

  it('says nothing about the token when the server does not', async () => {
    mockGet
      .mockResolvedValueOnce({ id: 1, name: 'Alice', email: 'alice@test.com' })
      .mockResolvedValueOnce({ data: [{ id: 1, name: 'Team A' }], current_team_id: 1 });

    await whoamiCommand.parseAsync(['node', 'test']);

    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('Token works in'));
  });

  it('gives the token\'s project in JSON', async () => {
    const { setJsonMode } = await import('../../src/lib/json-mode.js');
    setJsonMode(true);
    mockGet
      .mockResolvedValueOnce({ id: 1, name: 'Alice', email: 'alice@test.com' })
      .mockResolvedValueOnce({ data: [{ id: 1, name: 'Team A' }, { id: 2, name: 'Team B' }], current_team_id: 2, token_team_id: 2 });

    try {
      await whoamiCommand.parseAsync(['node', 'test']);

      const printed = JSON.parse(consoleLogSpy.mock.calls.at(-1)![0] as string).data;
      expect(printed).toMatchObject({ current_team_id: 2, token_team_id: 2 });
    } finally {
      setJsonMode(false);
    }
  });
});

