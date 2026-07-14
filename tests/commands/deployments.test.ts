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
            id: 1, revision_number: 3, status: 'active', is_current: true,
            trigger_type: 'cli', deployed_at: '2024-06-01T12:00:00Z', created_at: '2024-06-01T11:00:00Z',
          },
          {
            id: 2, revision_number: 2, status: 'inactive', is_current: false,
            trigger_type: 'cli', deployed_at: null, created_at: '2024-05-31T10:00:00Z',
          },
        ],
      });

      await deploymentsCommand.parseAsync(['node', 'test', 'ls']);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('REVISION'));
    });

    it('fetches every page and shows a truncation note when capped', async () => {
      mockReadProjectConfig.mockResolvedValue({ siteId: 1, teamId: 1, siteName: 'test' });
      mockGet.mockResolvedValue({
        data: [{
          id: 1, revision_number: 3, status: 'active', is_current: true,
          trigger_type: 'cli', deployed_at: '2024-06-01T12:00:00Z', created_at: '2024-06-01T11:00:00Z',
        }],
        pagination: { current_page: 1, last_page: 1, per_page: 100, total: 250 },
      });

      await deploymentsCommand.parseAsync(['node', 'test', 'ls']);

      expect(mockGet).toHaveBeenCalledWith('/api/v1/static-sites/1/deployments?per_page=100&page=1');
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Showing 1 of 250');
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
      mockGet.mockResolvedValue({ data: [{ id: 5, revision_number: 2 }, { id: 3, revision_number: 1 }] });
      mockPost.mockResolvedValue({ message: 'Activated' });

      await deploymentsCommand.parseAsync(['node', 'test', 'rollback', '2']);

      expect(mockPost).toHaveBeenCalledWith('/api/v1/static-sites/1/deployments/5/activate');
    });

    it('walks multiple pages to find a revision beyond the first page', async () => {
      mockReadProjectConfig.mockResolvedValue({ siteId: 1, teamId: 1, siteName: 'test' });
      mockGet
        .mockResolvedValueOnce({
          data: [{ id: 1, revision_number: 3 }],
          pagination: { current_page: 1, last_page: 2, per_page: 100, total: 2 },
        })
        .mockResolvedValueOnce({
          data: [{ id: 2, revision_number: 2 }],
          pagination: { current_page: 2, last_page: 2, per_page: 100, total: 2 },
        });
      mockPost.mockResolvedValue({ message: 'Activated' });

      await deploymentsCommand.parseAsync(['node', 'test', 'rollback', '2']);

      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(mockGet).toHaveBeenNthCalledWith(1, '/api/v1/static-sites/1/deployments?per_page=100&page=1');
      expect(mockGet).toHaveBeenNthCalledWith(2, '/api/v1/static-sites/1/deployments?per_page=100&page=2');
      expect(mockPost).toHaveBeenCalledWith('/api/v1/static-sites/1/deployments/2/activate');
    });
  });
});
