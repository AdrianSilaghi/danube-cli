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

const { snapshotsCommand } = await import('../../../src/commands/cache/snapshots.js');

class ExitError extends Error {
  constructor(public code: number) { super(`process.exit(${code})`); }
}

const makeSnapshot = (overrides = {}) => ({
  id: 'snap-1',
  name: 'daily-backup',
  description: null,
  status: 'ready',
  size_mb: 1024,
  cache_instance_id: 'cache-1',
  cache_instance: { id: 'cache-1', name: 'my-cache' },
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('cache snapshots', () => {
  const originalExit = process.exit;
  const originalIsTTY = process.stdin.isTTY;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exit = vi.fn().mockImplementation((code: number) => { throw new ExitError(code); }) as never;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mockGet.mockReset(); mockPost.mockReset(); mockDelete.mockReset(); mockConfirm.mockReset();
  });

  afterEach(() => {
    process.exit = originalExit;
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    vi.restoreAllMocks();
  });

  describe('ls', () => {
    it('lists snapshots', async () => {
      mockGet.mockResolvedValue({ data: [makeSnapshot(), makeSnapshot({ id: 'snap-2', name: 'hourly' })] });
      await snapshotsCommand.parseAsync(['node', 'test', 'ls']);
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('daily-backup');
      expect(output).toContain('hourly');
    });

    it('filters by --instance', async () => {
      mockGet
        .mockResolvedValueOnce({
          data: [makeSnapshot(), makeSnapshot({ id: 'snap-2', cache_instance_id: 'other', cache_instance: { id: 'other', name: 'other' } })],
        })
        .mockResolvedValueOnce({ data: [{ id: 'cache-1', name: 'my-cache' }] });
      await snapshotsCommand.parseAsync(['node', 'test', 'ls', '--instance', 'cache-1']);
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('snap-1');
      expect(output).not.toContain('snap-2');
    });

    it('resolves the --instance filter by name', async () => {
      mockGet
        .mockResolvedValueOnce({
          data: [makeSnapshot(), makeSnapshot({ id: 'snap-2', cache_instance_id: 'other', cache_instance: { id: 'other', name: 'other' } })],
        })
        .mockResolvedValueOnce({ data: [{ id: 'cache-1', name: 'prod-cache' }] });
      await snapshotsCommand.parseAsync(['node', 'test', 'ls', '--instance', 'prod-cache']);
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('snap-1');
      expect(output).not.toContain('snap-2');
    });

    it('handles empty list', async () => {
      mockGet.mockResolvedValue({ data: [] });
      await snapshotsCommand.parseAsync(['node', 'test', 'ls']);
      expect(consoleLogSpy).toHaveBeenCalledWith('No cache snapshots found.');
    });

    it('truncation note reflects the unfiltered total, not the --instance-filtered subset', async () => {
      mockGet
        .mockResolvedValueOnce({
          data: [makeSnapshot(), makeSnapshot({ id: 'snap-2', cache_instance_id: 'other', cache_instance: { id: 'other', name: 'other' } })],
          pagination: { current_page: 1, last_page: 1, per_page: 100, total: 50 },
        })
        .mockResolvedValueOnce({ data: [{ id: 'cache-1', name: 'my-cache' }] });
      await snapshotsCommand.parseAsync(['node', 'test', 'ls', '--instance', 'cache-1']);
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('snap-1');
      expect(output).not.toContain('snap-2');
      expect(output).toContain('Showing 2 of 50');
    });
  });

  describe('create', () => {
    it('posts with name and description', async () => {
      mockGet.mockResolvedValueOnce({ data: [{ id: 'cache-1', name: 'my-cache' }] });
      mockPost.mockResolvedValue({ message: 'ok', snapshot: makeSnapshot() });
      await snapshotsCommand.parseAsync(['node', 'test', 'create', 'cache-1', '--name', 'daily-backup', '--description', 'test']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/snapshots/cache', {
        cache_instance_id: 'cache-1',
        name: 'daily-backup',
        description: 'test',
      });
    });

    it('resolves the target cache instance by name', async () => {
      mockGet.mockResolvedValueOnce({ data: [{ id: 'cache-1', name: 'prod-cache' }] });
      mockPost.mockResolvedValue({ message: 'ok', snapshot: makeSnapshot() });
      await snapshotsCommand.parseAsync(['node', 'test', 'create', 'prod-cache', '--name', 'daily-backup']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/snapshots/cache', {
        cache_instance_id: 'cache-1',
        name: 'daily-backup',
      });
    });

    it('exits without --name', async () => {
      await expect(snapshotsCommand.parseAsync(['node', 'test', 'create', 'cache-1'])).rejects.toThrow(ExitError);
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe('restore', () => {
    it('confirms before restoring', async () => {
      mockConfirm.mockResolvedValue(true);
      mockPost.mockResolvedValue({ message: 'Restoring' });
      await snapshotsCommand.parseAsync(['node', 'test', 'restore', 'snap-1']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/snapshots/cache/snap-1/restore');
    });

    it('skips confirm with --force', async () => {
      mockPost.mockResolvedValue({ message: 'Restoring' });
      await snapshotsCommand.parseAsync(['node', 'test', 'restore', 'snap-1', '--force']);
      expect(mockConfirm).not.toHaveBeenCalled();
    });
  });

  describe('clone', () => {
    it('clones with name and default source-type', async () => {
      mockPost.mockResolvedValue({ message: 'ok', instance: { id: 'cache-2', name: 'clone' } });
      await snapshotsCommand.parseAsync(['node', 'test', 'clone', 'snap-1', '--name', 'clone']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/snapshots/cache/snap-1/clone', {
        name: 'clone',
        source_type: 'volume_snapshot',
      });
    });

    it('rejects invalid --source-type', async () => {
      await expect(
        snapshotsCommand.parseAsync(['node', 'test', 'clone', 'snap-1', '--name', 'x', '--source-type', 'bogus']),
      ).rejects.toThrow(ExitError);
    });
  });

  describe('rm', () => {
    it('deletes with --force', async () => {
      mockDelete.mockResolvedValue({ message: 'ok' });
      await snapshotsCommand.parseAsync(['node', 'test', 'rm', 'snap-1', '--force']);
      expect(mockDelete).toHaveBeenCalledWith('/api/v1/snapshots/cache/snap-1');
    });

    it('refuses JSON-mode rm without --force', async () => {
      const { setJsonMode } = await import('../../../src/lib/json-mode.js');
      setJsonMode(true);
      await expect(snapshotsCommand.parseAsync(['node', 'test', 'rm', 'snap-1'])).rejects.toThrow(/without --force/);
      expect(mockDelete).not.toHaveBeenCalled();
      setJsonMode(false);
    });

    it('gains a delete alias', () => {
      const rmCmd = snapshotsCommand.commands.find((c) => c.name() === 'rm');
      expect(rmCmd?.aliases()).toContain('delete');
    });
  });
});
