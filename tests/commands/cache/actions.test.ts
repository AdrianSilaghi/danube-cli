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

const { startCommand, stopCommand, connectionInfoCommand, dnsCommand } = await import('../../../src/commands/cache/actions.js');

describe('cache actions', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGet.mockReset(); mockPost.mockReset(); mockDelete.mockReset(); mockConfirm.mockReset();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  describe('start', () => {
    it('posts to /start', async () => {
      mockPost.mockResolvedValue({ message: 'Starting', status: 'starting' });
      await startCommand.parseAsync(['node', 'test', 'cache-1']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/cache/cache-1/start');
    });
  });

  describe('stop', () => {
    it('posts to /stop', async () => {
      mockPost.mockResolvedValue({ message: 'Stopping', status: 'stopping' });
      await stopCommand.parseAsync(['node', 'test', 'cache-1']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/cache/cache-1/stop');
    });
  });

  describe('connection-info', () => {
    it('shows connection and password after confirm', async () => {
      mockConfirm.mockResolvedValue(true);
      mockGet.mockResolvedValue({ connection_info: 'redis://foo:6379', password: 'secret' });
      await connectionInfoCommand.parseAsync(['node', 'test', 'cache-1']);
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('redis://foo:6379');
      expect(output).toContain('secret');
    });

    it('cancels if confirm returns false', async () => {
      mockConfirm.mockResolvedValue(false);
      await connectionInfoCommand.parseAsync(['node', 'test', 'cache-1']);
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe('dns', () => {
    it('enables dns', async () => {
      mockPost.mockResolvedValue({ message: 'DNS enabled' });
      await dnsCommand.parseAsync(['node', 'test', 'enable', 'cache-1']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/cache/cache-1/dns');
    });

    it('disables dns', async () => {
      mockDelete.mockResolvedValue({ message: 'DNS disabled' });
      await dnsCommand.parseAsync(['node', 'test', 'disable', 'cache-1']);
      expect(mockDelete).toHaveBeenCalledWith('/api/v1/cache/cache-1/dns');
    });
  });
});
