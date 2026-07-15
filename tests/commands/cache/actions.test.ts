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

const listResponse = (overrides = {}) => ({ data: [{ id: 'cache-1', name: 'my-cache', ...overrides }] });

describe('cache actions', () => {
  const originalIsTTY = process.stdin.isTTY;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mockGet.mockReset(); mockPost.mockReset(); mockDelete.mockReset(); mockConfirm.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    vi.restoreAllMocks();
  });

  describe('start', () => {
    it('posts to /start', async () => {
      mockGet.mockResolvedValueOnce(listResponse());
      mockPost.mockResolvedValue({ message: 'Starting', status: 'starting' });
      await startCommand.parseAsync(['node', 'test', 'cache-1']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/cache/cache-1/start');
    });

    it('resolves a cache instance by name', async () => {
      mockGet.mockResolvedValueOnce(listResponse({ id: 'cache-9', name: 'prod-cache' }));
      mockPost.mockResolvedValue({ message: 'Starting', status: 'starting' });
      await startCommand.parseAsync(['node', 'test', 'prod-cache']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/cache/cache-9/start');
    });
  });

  describe('stop', () => {
    it('posts to /stop', async () => {
      mockGet.mockResolvedValueOnce(listResponse());
      mockPost.mockResolvedValue({ message: 'Stopping', status: 'stopping' });
      await stopCommand.parseAsync(['node', 'test', 'cache-1']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/cache/cache-1/stop');
    });
  });

  describe('connection-info', () => {
    it('shows connection and password after confirm', async () => {
      mockConfirm.mockResolvedValue(true);
      mockGet
        .mockResolvedValueOnce(listResponse())
        .mockResolvedValueOnce({ connection_info: 'redis://foo:6379', password: 'secret' });
      await connectionInfoCommand.parseAsync(['node', 'test', 'cache-1']);
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('redis://foo:6379');
      expect(output).toContain('secret');
    });

    it('cancels if confirm returns false', async () => {
      mockGet.mockResolvedValueOnce(listResponse());
      mockConfirm.mockResolvedValue(false);
      await connectionInfoCommand.parseAsync(['node', 'test', 'cache-1']);
      // Resolution (list) happens before the confirm, but the reveal call itself must not.
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('refuses JSON-mode reveal without --force', async () => {
      const { setJsonMode } = await import('../../../src/lib/json-mode.js');
      setJsonMode(true);
      mockGet.mockResolvedValueOnce(listResponse());
      await expect(connectionInfoCommand.parseAsync(['node', 'test', 'cache-1'])).rejects.toThrow(/without --force/);
      expect(mockGet).toHaveBeenCalledTimes(1);
      setJsonMode(false);
    });
  });

  describe('dns', () => {
    it('enables dns', async () => {
      mockGet.mockResolvedValueOnce(listResponse());
      mockPost.mockResolvedValue({ message: 'DNS enabled' });
      await dnsCommand.parseAsync(['node', 'test', 'enable', 'cache-1']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/cache/cache-1/dns');
    });

    it('disables dns', async () => {
      mockGet.mockResolvedValueOnce(listResponse());
      mockDelete.mockResolvedValue({ message: 'DNS disabled' });
      await dnsCommand.parseAsync(['node', 'test', 'disable', 'cache-1']);
      expect(mockDelete).toHaveBeenCalledWith('/api/v1/cache/cache-1/dns');
    });
  });
});
