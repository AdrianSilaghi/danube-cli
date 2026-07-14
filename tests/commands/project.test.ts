import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
vi.mock('../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet }),
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
    const printed = JSON.parse(consoleLogSpy.mock.calls.at(-1)![0] as string);
    expect(printed).toEqual({ id: 1, name: 'Solo Team' });
    setJsonMode(false);
  });
});
