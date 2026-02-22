import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet, post: mockPost }),
  },
}));

const mockReadProjectConfig = vi.fn();
vi.mock('../../src/lib/project.js', () => ({
  readProjectConfig: () => mockReadProjectConfig(),
}));

vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  }),
}));

const { deploymentsCommand } = await import('../../src/commands/deployments.js');

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

describe('deployments command', () => {
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
    mockReadProjectConfig.mockReset();
  });

  afterEach(() => {
    process.exit = originalExit;
    vi.restoreAllMocks();
  });

  describe('ls', () => {
    it('throws NotLinkedError when no project', async () => {
      mockReadProjectConfig.mockResolvedValue(null);
      await expect(
        deploymentsCommand.parseAsync(['node', 'test', 'ls']),
      ).rejects.toThrow('No project linked');
    });

    it('shows message when no deployments', async () => {
      mockReadProjectConfig.mockResolvedValue({ siteId: 1, teamId: 1, siteName: 'test' });
      mockGet.mockResolvedValue({ data: [] });

      await deploymentsCommand.parseAsync(['node', 'test', 'ls']);

      expect(consoleLogSpy).toHaveBeenCalledWith('No deployments yet.');
    });

    it('displays deployments table', async () => {
      mockReadProjectConfig.mockResolvedValue({ siteId: 1, teamId: 1, siteName: 'test' });
      mockGet.mockResolvedValue({
        data: [
          {
            id: 1, revision: 3, is_active: true,
            activated_at: '2024-06-01T12:00:00Z', created_at: '2024-06-01T11:00:00Z',
          },
          {
            id: 2, revision: 2, is_active: false,
            activated_at: null, created_at: '2024-05-31T10:00:00Z',
          },
        ],
      });

      await deploymentsCommand.parseAsync(['node', 'test', 'ls']);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('REVISION'));
    });
  });

  describe('rollback', () => {
    it('throws NotLinkedError when no project', async () => {
      mockReadProjectConfig.mockResolvedValue(null);
      await expect(
        deploymentsCommand.parseAsync(['node', 'test', 'rollback', '2']),
      ).rejects.toThrow('No project linked');
    });

    it('exits when revision not found', async () => {
      mockReadProjectConfig.mockResolvedValue({ siteId: 1, teamId: 1, siteName: 'test' });
      mockGet.mockResolvedValue({ data: [{ id: 1, revision: 3 }] });

      await expect(
        deploymentsCommand.parseAsync(['node', 'test', 'rollback', '99']),
      ).rejects.toThrow(ExitError);

      expect(process.exit).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
    });

    it('activates the deployment', async () => {
      mockReadProjectConfig.mockResolvedValue({ siteId: 1, teamId: 1, siteName: 'test' });
      mockGet.mockResolvedValue({ data: [{ id: 5, revision: 2 }, { id: 3, revision: 1 }] });
      mockPost.mockResolvedValue({ message: 'Activated' });

      await deploymentsCommand.parseAsync(['node', 'test', 'rollback', '2']);

      expect(mockPost).toHaveBeenCalledWith('/api/v1/static-sites/1/deployments/5/activate');
    });
  });
});
