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

const { snapshotsCommand } = await import('../../../src/commands/database/snapshots.js');

class ExitError extends Error {
  constructor(public code: number) { super(`process.exit(${code})`); }
}

const makeSnapshot = (overrides = {}) => ({
  id: 'snap-1',
  name: 'nightly',
  description: null,
  status: 'ready',
  size_gb: 20,
  database_instance_id: 'db-1',
  database_instance: { id: 'db-1', name: 'my-db' },
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('database snapshots', () => {
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
      mockGet.mockResolvedValue({ data: [makeSnapshot()] });
      await snapshotsCommand.parseAsync(['node', 'test', 'ls']);
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('nightly');
    });

    it('filters by --instance', async () => {
      mockGet
        .mockResolvedValueOnce({
          data: [makeSnapshot(), makeSnapshot({ id: 'snap-2', database_instance_id: 'other', database_instance: { id: 'other', name: 'other' } })],
        })
        .mockResolvedValueOnce({ data: [{ id: 'db-1', name: 'my-db' }] });
      await snapshotsCommand.parseAsync(['node', 'test', 'ls', '--instance', 'db-1']);
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('snap-1');
      expect(output).not.toContain('snap-2');
    });

    it('resolves the --instance filter by name', async () => {
      mockGet
        .mockResolvedValueOnce({
          data: [makeSnapshot(), makeSnapshot({ id: 'snap-2', database_instance_id: 'other', database_instance: { id: 'other', name: 'other' } })],
        })
        .mockResolvedValueOnce({ data: [{ id: 'db-1', name: 'prod-db' }] });
      await snapshotsCommand.parseAsync(['node', 'test', 'ls', '--instance', 'prod-db']);
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('snap-1');
      expect(output).not.toContain('snap-2');
    });

    it('shows empty message', async () => {
      mockGet.mockResolvedValue({ data: [] });
      await snapshotsCommand.parseAsync(['node', 'test', 'ls']);
      expect(consoleLogSpy).toHaveBeenCalledWith('No database snapshots found.');
    });
  });

  describe('create', () => {
    it('posts with name', async () => {
      mockGet.mockResolvedValueOnce({ data: [{ id: 'db-1', name: 'my-db' }] });
      mockPost.mockResolvedValue({ message: 'ok', snapshot: makeSnapshot() });
      await snapshotsCommand.parseAsync(['node', 'test', 'create', 'db-1', '--name', 'nightly', '--description', 'x']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/snapshots/database', {
        database_instance_id: 'db-1',
        name: 'nightly',
        description: 'x',
      });
    });

    it('resolves the target database instance by name', async () => {
      mockGet.mockResolvedValueOnce({ data: [{ id: 'db-1', name: 'prod-db' }] });
      mockPost.mockResolvedValue({ message: 'ok', snapshot: makeSnapshot() });
      await snapshotsCommand.parseAsync(['node', 'test', 'create', 'prod-db', '--name', 'nightly']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/snapshots/database', {
        database_instance_id: 'db-1',
        name: 'nightly',
      });
    });

    it('exits without --name', async () => {
      await expect(snapshotsCommand.parseAsync(['node', 'test', 'create', 'db-1'])).rejects.toThrow(ExitError);
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe('restore', () => {
    it('restores with --force', async () => {
      mockPost.mockResolvedValue({ message: 'Restoring' });
      await snapshotsCommand.parseAsync(['node', 'test', 'restore', 'snap-1', '--force']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/snapshots/database/snap-1/restore');
    });

    it('confirms before restoring', async () => {
      mockConfirm.mockResolvedValue(true);
      mockPost.mockResolvedValue({ message: 'Restoring' });
      await snapshotsCommand.parseAsync(['node', 'test', 'restore', 'snap-1']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/snapshots/database/snap-1/restore');
    });

    it('cancels when confirm returns false', async () => {
      mockConfirm.mockResolvedValue(false);
      await snapshotsCommand.parseAsync(['node', 'test', 'restore', 'snap-1']);
      expect(mockPost).not.toHaveBeenCalled();
    });
  });

  describe('clone', () => {
    it('clones with --database-name', async () => {
      mockPost.mockResolvedValue({ message: 'ok', instance: { id: 'db-2', name: 'clone' } });
      await snapshotsCommand.parseAsync([
        'node', 'test', 'clone', 'snap-1', '--name', 'clone', '--database-name', 'appdb',
      ]);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/snapshots/database/snap-1/clone', {
        name: 'clone',
        source_type: 'volume_snapshot',
        database_name: 'appdb',
      });
    });

    it('rejects bad --source-type', async () => {
      await expect(snapshotsCommand.parseAsync([
        'node', 'test', 'clone', 'snap-1', '--name', 'x', '--source-type', 'bogus',
      ])).rejects.toThrow(ExitError);
    });
  });

  describe('rm', () => {
    it('deletes with --force', async () => {
      mockDelete.mockResolvedValue({ message: 'ok' });
      await snapshotsCommand.parseAsync(['node', 'test', 'rm', 'snap-1', '--force']);
      expect(mockDelete).toHaveBeenCalledWith('/api/v1/snapshots/database/snap-1');
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
