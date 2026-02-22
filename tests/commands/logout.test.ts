import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockDeleteConfig = vi.fn();
vi.mock('../../src/lib/config.js', () => ({
  deleteConfig: () => mockDeleteConfig(),
}));

const { logoutCommand } = await import('../../src/commands/logout.js');

describe('logout command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockDeleteConfig.mockReset();
    mockDeleteConfig.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('deletes config and confirms', async () => {
    await logoutCommand.parseAsync(['node', 'test']);

    expect(mockDeleteConfig).toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Logged out'));
  });
});
