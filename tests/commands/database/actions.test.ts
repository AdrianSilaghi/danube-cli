import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockDelete = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet, post: mockPost, delete: mockDelete }),
  },
}));

vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  }),
}));

const mockConfirm = vi.fn();
vi.mock('@inquirer/prompts', () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

const { startCommand, stopCommand, credentialsCommand, dnsCommand } = await import('../../../src/commands/database/actions.js');

describe('database actions', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGet.mockReset(); mockPost.mockReset(); mockDelete.mockReset(); mockConfirm.mockReset();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('starts', async () => {
    mockPost.mockResolvedValue({ message: 'Starting', status: 'starting' });
    await startCommand.parseAsync(['node', 'test', 'db-1']);
    expect(mockPost).toHaveBeenCalledWith('/api/v1/database/db-1/start');
  });

  it('stops', async () => {
    mockPost.mockResolvedValue({ message: 'Stopping', status: 'stopping' });
    await stopCommand.parseAsync(['node', 'test', 'db-1']);
    expect(mockPost).toHaveBeenCalledWith('/api/v1/database/db-1/stop');
  });

  describe('credentials', () => {
    it('prints credentials after confirm', async () => {
      mockConfirm.mockResolvedValue(true);
      mockGet.mockResolvedValue({ connection_info: 'mysql://root@db:3306', username: 'root', password: 'secret' });
      await credentialsCommand.parseAsync(['node', 'test', 'db-1']);
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('root');
      expect(output).toContain('secret');
      expect(output).toContain('mysql://root@db:3306');
    });

    it('cancels on declined confirm', async () => {
      mockConfirm.mockResolvedValue(false);
      await credentialsCommand.parseAsync(['node', 'test', 'db-1']);
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe('dns', () => {
    it('enables', async () => {
      mockPost.mockResolvedValue({ message: 'DNS enabled' });
      await dnsCommand.parseAsync(['node', 'test', 'enable', 'db-1']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/database/db-1/dns');
    });

    it('disables', async () => {
      mockDelete.mockResolvedValue({ message: 'DNS disabled' });
      await dnsCommand.parseAsync(['node', 'test', 'disable', 'db-1']);
      expect(mockDelete).toHaveBeenCalledWith('/api/v1/database/db-1/dns');
    });
  });
});
