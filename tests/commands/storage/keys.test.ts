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

const mockInput = vi.fn();
const mockConfirm = vi.fn();
vi.mock('@inquirer/prompts', () => ({
  input: (...args: unknown[]) => mockInput(...args),
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

const { keysCommand } = await import('../../../src/commands/storage/keys.js');

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

const makeKey = (overrides = {}) => ({
  id: 'key-1',
  team_id: 1,
  name: 'my-key',
  access_key_id: 'AKIAEXAMPLE123',
  status: 'active',
  expires_at: null,
  last_used_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('keys command', () => {
  const originalExit = process.exit;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exit = vi.fn().mockImplementation((code: number) => {
      throw new ExitError(code);
    }) as never;
    mockGet.mockReset();
    mockPost.mockReset();
    mockDelete.mockReset();
    mockInput.mockReset();
    mockConfirm.mockReset();
  });

  afterEach(() => {
    process.exit = originalExit;
    vi.restoreAllMocks();
  });

  describe('ls', () => {
    it('shows message when no keys', async () => {
      mockGet.mockResolvedValue({ data: [] });

      await keysCommand.parseAsync(['node', 'test', 'ls']);

      expect(consoleLogSpy).toHaveBeenCalledWith('No access keys found.');
    });

    it('displays keys table', async () => {
      mockGet.mockResolvedValue({
        data: [
          makeKey(),
          makeKey({ id: 'key-2', name: 'other-key', access_key_id: 'AKIAOTHER456' }),
        ],
      });

      await keysCommand.parseAsync(['node', 'test', 'ls']);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('NAME'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('AKIAEXAMPLE123'));
    });
  });

  describe('create', () => {
    it('creates key with --name flag', async () => {
      mockPost.mockResolvedValue({
        message: 'Created',
        ...makeKey({ name: 'cli-key' }),
        secret_access_key: 'SECRET123456',
      });

      await keysCommand.parseAsync(['node', 'test', 'create', '--name', 'cli-key']);

      expect(mockPost).toHaveBeenCalledWith('/api/v1/storage/access-keys', { name: 'cli-key' });
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('SECRET123456'));
    });

    it('creates key with expiration', async () => {
      mockPost.mockResolvedValue({
        message: 'Created',
        ...makeKey({ name: 'temp-key', expires_at: '2025-12-31T00:00:00Z' }),
        secret_access_key: 'TEMPSECRET',
      });

      await keysCommand.parseAsync([
        'node', 'test', 'create',
        '--name', 'temp-key',
        '--expires', '2025-12-31T00:00:00Z',
      ]);

      expect(mockPost).toHaveBeenCalledWith('/api/v1/storage/access-keys', {
        name: 'temp-key',
        expires_at: '2025-12-31T00:00:00Z',
      });
    });

    it('prompts for name when not provided', async () => {
      mockInput.mockResolvedValue('prompted-key');
      mockPost.mockResolvedValue({
        message: 'Created',
        ...makeKey({ name: 'prompted-key' }),
        secret_access_key: 'SECRETPROMPTED',
      });

      await keysCommand.parseAsync(['node', 'test', 'create']);

      expect(mockInput).toHaveBeenCalled();
      expect(mockPost).toHaveBeenCalledWith('/api/v1/storage/access-keys', { name: 'prompted-key' });
    });
  });

  describe('get', () => {
    it('displays key details', async () => {
      mockGet.mockResolvedValue({ access_key: makeKey() });

      await keysCommand.parseAsync(['node', 'test', 'get', 'key-1']);

      expect(mockGet).toHaveBeenCalledWith('/api/v1/storage/access-keys/key-1');
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('my-key'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('AKIAEXAMPLE123'));
    });
  });

  describe('revoke', () => {
    it('revokes key with --force', async () => {
      mockDelete.mockResolvedValue({ message: 'Revoked' });

      await keysCommand.parseAsync(['node', 'test', 'revoke', 'key-1', '--force']);

      expect(mockDelete).toHaveBeenCalledWith('/api/v1/storage/access-keys/key-1');
    });

    it('asks for confirmation and revokes', async () => {
      mockConfirm.mockResolvedValue(true);
      mockDelete.mockResolvedValue({ message: 'Revoked' });

      await keysCommand.parseAsync(['node', 'test', 'revoke', 'key-1']);

      expect(mockConfirm).toHaveBeenCalled();
      expect(mockDelete).toHaveBeenCalledWith('/api/v1/storage/access-keys/key-1');
    });

    it('cancels when user declines', async () => {
      mockConfirm.mockResolvedValue(false);

      await keysCommand.parseAsync(['node', 'test', 'revoke', 'key-1']);

      expect(consoleLogSpy).toHaveBeenCalledWith('Cancelled.');
      expect(mockDelete).not.toHaveBeenCalled();
    });
  });
});
