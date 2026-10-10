import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockCreate = vi.fn();
vi.mock('../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: (...args: unknown[]) => {
      mockCreate(...args);
      return Promise.resolve({ get: mockGet });
    },
  },
}));

const mockReadConfig = vi.fn();
const mockWriteConfig = vi.fn();
vi.mock('../../src/lib/config.js', () => ({
  readConfig: (...args: unknown[]) => mockReadConfig(...args),
  writeConfig: (...args: unknown[]) => mockWriteConfig(...args),
}));

const mockSelect = vi.fn();
vi.mock('@inquirer/prompts', () => ({
  select: (...args: unknown[]) => mockSelect(...args),
}));

const { projectCommand } = await import('../../src/commands/project.js');

describe('project select command', () => {
  const originalIsTTY = process.stdin.isTTY;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mockGet.mockReset();
    mockCreate.mockReset();
    mockReadConfig.mockReset();
    mockWriteConfig.mockReset();
    mockSelect.mockReset();
    mockReadConfig.mockResolvedValue(null);
    mockWriteConfig.mockResolvedValue(undefined);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    vi.restoreAllMocks();
  });

  it('refuses to run under --json when multiple projects require a prompt', async () => {
    const { setJsonMode } = await import('../../src/lib/json-mode.js');
    setJsonMode(true);
    mockGet.mockResolvedValue({
      data: [
        { id: 1, name: 'Team A', personal_team: false },
        { id: 2, name: 'Team B', personal_team: false },
      ],
    });

    await expect(projectCommand.parseAsync(['node', 'test', 'select'])).rejects.toThrow(/interactive/);

    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockWriteConfig).not.toHaveBeenCalled();
    setJsonMode(false);
  });

  it('still auto-selects a sole project under --json without prompting', async () => {
    const { setJsonMode } = await import('../../src/lib/json-mode.js');
    setJsonMode(true);
    mockGet.mockResolvedValue({ data: [{ id: 1, name: 'Solo Team', personal_team: false }] });
    mockReadConfig.mockResolvedValue({ token: 'tok' });

    await projectCommand.parseAsync(['node', 'test', 'select']);

    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockWriteConfig).toHaveBeenCalledWith({ token: 'tok', teamId: 1, teamName: 'Solo Team' });
    const printed = JSON.parse(consoleLogSpy.mock.calls.at(-1)![0] as string).data;
    expect(printed).toEqual({ id: 1, name: 'Solo Team' });
    setJsonMode(false);
  });
});

describe('project commands with a token locked to one project', () => {
  const originalIsTTY = process.stdin.isTTY;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  // Team B is the project the token was made for: the API refuses it in Team A.
  const lockedToB = {
    data: [
      { id: 1, name: 'Team A', personal_team: true },
      { id: 2, name: 'Team B', personal_team: false },
    ],
    current_team_id: 2,
    token_team_id: 2,
  };

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mockGet.mockReset();
    mockCreate.mockReset();
    mockReadConfig.mockReset();
    mockWriteConfig.mockReset();
    mockSelect.mockReset();
    mockReadConfig.mockResolvedValue({ token: 't', teamId: 1, teamName: 'Team A' });
    mockWriteConfig.mockResolvedValue(undefined);
    mockGet.mockResolvedValue(lockedToB);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    vi.restoreAllMocks();
  });

  it('lists and selects without sending a project, so a stale selection cannot block them', async () => {
    await projectCommand.parseAsync(['node', 'test', 'ls']);
    await projectCommand.parseAsync(['node', 'test', 'select']);

    expect(mockCreate.mock.calls).toEqual([[{ unscoped: true }], [{ unscoped: true }]]);
  });

  it('refuses a project the token is refused in, naming the one it works in', async () => {
    await expect(projectCommand.parseAsync(['node', 'test', 'select', '--project', '1']))
      .rejects.toThrow(/works in Team B \(id 2\) only.*All your projects/);

    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  it('selects the locked project without asking, since it is the only one the token works in', async () => {
    await projectCommand.parseAsync(['node', 'test', 'select']);

    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockWriteConfig).toHaveBeenCalledWith({ token: 't', teamId: 2, teamName: 'Team B' });
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('the only project this token works in'));
  });

  it('marks the projects the token cannot be used in', async () => {
    await projectCommand.parseAsync(['node', 'test', 'ls']);

    const lines = consoleLogSpy.mock.calls.map(c => String(c[0]));
    expect(lines.find(l => l.includes('Team A'))).toContain('[not for this token]');
    expect(lines.find(l => l.includes('Team B'))).not.toContain('[not for this token]');
  });

  it('still lets an account-wide token pick any project', async () => {
    mockGet.mockResolvedValue({ ...lockedToB, token_team_id: null });
    mockSelect.mockResolvedValue(1);

    await projectCommand.parseAsync(['node', 'test', 'select']);

    expect(mockSelect).toHaveBeenCalled();
    expect(mockWriteConfig).toHaveBeenCalledWith({ token: 't', teamId: 1, teamName: 'Team A' });
  });
});
