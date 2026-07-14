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

const listResponse = (overrides = {}) => ({ data: [{ id: 'db-1', name: 'my-db', ...overrides }] });

describe('database actions', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGet.mockReset(); mockPost.mockReset(); mockDelete.mockReset(); mockConfirm.mockReset();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('starts', async () => {
    mockGet.mockResolvedValueOnce(listResponse());
    mockPost.mockResolvedValue({ message: 'Starting', status: 'starting' });
    await startCommand.parseAsync(['node', 'test', 'db-1']);
    expect(mockPost).toHaveBeenCalledWith('/api/v1/database/db-1/start');
  });

  it('resolves a database instance by name', async () => {
    mockGet.mockResolvedValueOnce(listResponse({ id: 'db-9', name: 'prod-db' }));
    mockPost.mockResolvedValue({ message: 'Starting', status: 'starting' });
    await startCommand.parseAsync(['node', 'test', 'prod-db']);
    expect(mockPost).toHaveBeenCalledWith('/api/v1/database/db-9/start');
  });

  it('stops', async () => {
    mockGet.mockResolvedValueOnce(listResponse());
    mockPost.mockResolvedValue({ message: 'Stopping', status: 'stopping' });
    await stopCommand.parseAsync(['node', 'test', 'db-1']);
    expect(mockPost).toHaveBeenCalledWith('/api/v1/database/db-1/stop');
  });

  describe('credentials', () => {
    it('prints credentials after confirm', async () => {
      mockConfirm.mockResolvedValue(true);
      mockGet
        .mockResolvedValueOnce(listResponse())
        .mockResolvedValueOnce({ connection_info: 'mysql://root@db:3306', username: 'root', password: 'secret' });
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
      mockGet.mockResolvedValueOnce(listResponse());
      mockPost.mockResolvedValue({ message: 'DNS enabled' });
      await dnsCommand.parseAsync(['node', 'test', 'enable', 'db-1']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/database/db-1/dns');
    });

    it('disables', async () => {
      mockGet.mockResolvedValueOnce(listResponse());
      mockDelete.mockResolvedValue({ message: 'DNS disabled' });
      await dnsCommand.parseAsync(['node', 'test', 'disable', 'db-1']);
      expect(mockDelete).toHaveBeenCalledWith('/api/v1/database/db-1/dns');
    });
  });
});
