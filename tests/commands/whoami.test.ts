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
});
