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

const { snapshotsCommand } = await import('../../../src/commands/vps/snapshots.js');
const { vpsCommand } = await import('../../../src/commands/vps/index.js');
const { setJsonMode } = await import('../../../src/lib/json-mode.js');

class ExitError extends Error {
  constructor(public code: number) { super(`process.exit(${code})`); }
}

const makeSnapshot = (overrides = {}) => ({
  id: 41,
  name: 'before-upgrade',
  description: null,
  status: 'ready',
  size_bytes: 5368709120,
  size_basis: 'stored',
  size_gb: '5.00',
  vps_instance_id: 'vps-1',
  vps_instance: { id: 'vps-1', name: 'web-1', deleted_at: null },
  expires_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('vps snapshots', () => {
  const originalExit = process.exit;
  const originalIsTTY = process.stdin.isTTY;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  const logged = () => consoleLogSpy.mock.calls.map(c => c[0]).join('\n');

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
    setJsonMode(false);
    vi.restoreAllMocks();
  });

  it('is mounted on `vps` and answers to `snapshot`', () => {
    expect(vpsCommand.commands.map(c => c.name())).toContain('snapshots');
    expect(snapshotsCommand.aliases()).toContain('snapshot');
  });

  describe('ls', () => {
    it('lists snapshots with integer ids and marks a deleted VPS', async () => {
      mockGet.mockResolvedValue({
        data: [
          makeSnapshot(),
          makeSnapshot({ id: 42, name: 'old', vps_instance: { id: 'gone', name: 'dead-1', deleted_at: '2024-02-01T00:00:00Z' } }),
        ],
        pagination: { current_page: 1, last_page: 1, per_page: 100, total: 2 },
      });
      await snapshotsCommand.parseAsync(['node', 'test', 'ls']);
      expect(mockGet.mock.calls[0][0]).toMatch(/^\/api\/v1\/snapshots\/vps(\?|$)/);
      expect(logged()).toContain('before-upgrade');
      expect(logged()).toContain('web-1');
      expect(logged()).toContain('dead-1 (deleted)');
      expect(logged()).toContain('41');
    });

    it('filters by --instance name', async () => {
      mockGet
        .mockResolvedValueOnce({ data: [makeSnapshot(), makeSnapshot({ id: 42, name: 'other-snap', vps_instance_id: 'vps-2' })] })
        .mockResolvedValueOnce({ data: [{ id: 'vps-1', name: 'web-1' }] });
      await snapshotsCommand.parseAsync(['node', 'test', 'ls', '--instance', 'web-1']);
      expect(logged()).toContain('before-upgrade');
      expect(logged()).not.toContain('other-snap');
    });

    it('shows the empty message', async () => {
      mockGet.mockResolvedValue({ data: [] });
      await snapshotsCommand.parseAsync(['node', 'test', 'ls']);
      expect(consoleLogSpy).toHaveBeenCalledWith('No VPS snapshots found.');
    });
  });

  describe('create', () => {
    it('posts vps_instance_id, name and description', async () => {
      mockGet.mockResolvedValueOnce({ data: [{ id: 'vps-1', name: 'web-1' }] });
      mockPost.mockResolvedValue({ message: 'ok', snapshot: makeSnapshot() });
      await snapshotsCommand.parseAsync(['node', 'test', 'create', 'web-1', '--name', 'before-upgrade', '--description', 'x']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/snapshots/vps', {
        vps_instance_id: 'vps-1',
        name: 'before-upgrade',
        description: 'x',
      });
    });

    it('exits without --name', async () => {
      await expect(snapshotsCommand.parseAsync(['node', 'test', 'create', 'web-1'])).rejects.toThrow(ExitError);
      expect(mockPost).not.toHaveBeenCalled();
    });
  });

  describe('restore', () => {
    it('restores with --yes', async () => {
      mockPost.mockResolvedValue({ message: 'VPS snapshot restore initiated' });
      await snapshotsCommand.parseAsync(['node', 'test', 'restore', '41', '--yes']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/snapshots/vps/41/restore');
      expect(mockConfirm).not.toHaveBeenCalled();
    });

    it('warns that the disk is replaced and cancels on "no"', async () => {
      mockConfirm.mockResolvedValue(false);
      await snapshotsCommand.parseAsync(['node', 'test', 'restore', '41']);
      expect(JSON.stringify(mockConfirm.mock.calls[0])).toMatch(/replaces the disk/);
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('refuses JSON-mode restore without --force', async () => {
      setJsonMode(true);
      await expect(snapshotsCommand.parseAsync(['node', 'test', 'restore', '41'])).rejects.toThrow(/without --force/);
      expect(mockPost).not.toHaveBeenCalled();
    });
  });

  describe('rm', () => {
    it('deletes with --force and has a delete alias', async () => {
      mockDelete.mockResolvedValue({ message: 'ok' });
      await snapshotsCommand.parseAsync(['node', 'test', 'rm', '41', '--force']);
      expect(mockDelete).toHaveBeenCalledWith('/api/v1/snapshots/vps/41');
      expect(snapshotsCommand.commands.find(c => c.name() === 'rm')?.aliases()).toContain('delete');
    });

    it('refuses JSON-mode rm without --force', async () => {
      setJsonMode(true);
      await expect(snapshotsCommand.parseAsync(['node', 'test', 'rm', '41'])).rejects.toThrow(/without --force/);
      expect(mockDelete).not.toHaveBeenCalled();
    });
  });

  describe('clone', () => {
    const created = { message: 'VPS clone initiated', instance: { id: 'vps-9', name: 'web-copy', status: 'provisioning' } };

    it('posts the new name and says how to follow the provisioning', async () => {
      mockPost.mockResolvedValue(created);
      await snapshotsCommand.parseAsync(['node', 'test', 'clone', '41', '--name', 'web-copy']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/snapshots/vps/41/clone', { name: 'web-copy' });
      expect(logged()).toContain('danube vps get web-copy');
      expect(logged()).toMatch(/10 to 30 minutes/);
    });

    it('prints the new instance as JSON in json mode', async () => {
      setJsonMode(true);
      mockPost.mockResolvedValue(created);
      await snapshotsCommand.parseAsync(['node', 'test', 'clone', '41', '--name', 'web-copy']);
      expect(logged()).toContain('"web-copy"');
      expect(logged()).not.toContain('Provisioning takes');
    });

    it('exits without --name', async () => {
      await expect(snapshotsCommand.parseAsync(['node', 'test', 'clone', '41'])).rejects.toThrow(ExitError);
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('lets the server message for 404, 409 and 422 through to the error handler', async () => {
      const { ApiError } = await import('../../../src/lib/errors.js');
      const { handleError } = await import('../../../src/lib/handle-error.js');
      for (const [status, message] of [[404, 'Not found.'], [409, 'A clone of this snapshot is already running.'], [422, 'Snapshot export is not complete.']] as const) {
        mockPost.mockRejectedValueOnce(new ApiError(status, message));
        const err = await snapshotsCommand.parseAsync(['node', 'test', 'clone', '41', '--name', 'web-copy']).catch(e => e);
        expect(() => handleError(err)).toThrow(ExitError);
        expect(consoleErrorSpy.mock.calls.map(c => c[0]).join('\n')).toContain(`(${status}): ${message}`);
      }
    });
  });
});
