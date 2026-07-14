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

const { replicasCommand } = await import('../../../src/commands/database/replicas.js');

class ExitError extends Error {
  constructor(public code: number) { super(`process.exit(${code})`); }
}

const listResponse = (overrides = {}) => ({ data: [{ id: 'db-1', name: 'my-db', ...overrides }] });

describe('database replicas', () => {
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
    it('shows master + replicas', async () => {
      mockGet
        .mockResolvedValueOnce(listResponse())
        .mockResolvedValueOnce({
          replicas: [{
            name: 'db-1-replica-1',
            node_id: 'n1',
            replica_index: 1,
            endpoint: 'db-1-r1:3306',
            status: 'Running',
            ready: true,
            replication_status: 'syncing',
            seconds_behind_master: 0,
            is_replication_healthy: true,
          }],
          master: { name: 'db-1-master', node_id: 'm1', endpoint: 'db-1:3306', status: 'running', ready: true },
          billing: { hourly_cost_cents: 2, monthly_cost_cents: 1999 },
        });
      await replicasCommand.parseAsync(['node', 'test', 'ls', 'db-1']);
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('db-1-master');
      expect(output).toContain('db-1-replica-1');
    });

    it('resolves the database by name', async () => {
      mockGet
        .mockResolvedValueOnce(listResponse({ id: 'db-9', name: 'prod-db' }))
        .mockResolvedValueOnce({
          replicas: [],
          master: { name: 'prod-db', node_id: 'm1', endpoint: 'prod-db:3306', status: 'running', ready: true },
          billing: { hourly_cost_cents: 0, monthly_cost_cents: 0 },
        });
      await replicasCommand.parseAsync(['node', 'test', 'ls', 'prod-db']);
      expect(mockGet).toHaveBeenLastCalledWith('/api/v1/database/db-9/replicas');
    });

    it('reports no replicas', async () => {
      mockGet
        .mockResolvedValueOnce(listResponse())
        .mockResolvedValueOnce({
          replicas: [],
          master: { name: 'db-1', node_id: null, endpoint: null, status: 'running', ready: true },
          billing: { hourly_cost_cents: 0, monthly_cost_cents: 0 },
        });
      await replicasCommand.parseAsync(['node', 'test', 'ls', 'db-1']);
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('No replicas configured.');
    });
  });

  describe('add', () => {
    it('adds replica with default count', async () => {
      mockGet.mockResolvedValueOnce(listResponse());
      mockPost.mockResolvedValue({ message: 'ok', replicas: [{ status: 'success', replica_index: 1 }] });
      await replicasCommand.parseAsync(['node', 'test', 'add', 'db-1']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/database/db-1/replicas', { replica_count: 1 });
    });

    it('adds with --count', async () => {
      mockGet.mockResolvedValueOnce(listResponse());
      mockPost.mockResolvedValue({ message: 'ok', replicas: [] });
      await replicasCommand.parseAsync(['node', 'test', 'add', 'db-1', '--count', '3']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/database/db-1/replicas', { replica_count: 3 });
    });

    it('rejects invalid --count', async () => {
      await expect(replicasCommand.parseAsync(['node', 'test', 'add', 'db-1', '--count', '0']))
        .rejects.toThrow(ExitError);
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe('rm', () => {
    it('removes with --force', async () => {
      mockGet.mockResolvedValueOnce(listResponse());
      mockDelete.mockResolvedValue({ message: 'ok', status: 'success' });
      await replicasCommand.parseAsync(['node', 'test', 'rm', 'db-1', '2', '--force']);
      expect(mockDelete).toHaveBeenCalledWith('/api/v1/database/db-1/replicas/2');
    });

    it('cancels on declined confirm', async () => {
      mockGet.mockResolvedValueOnce(listResponse());
      mockConfirm.mockResolvedValue(false);
      await replicasCommand.parseAsync(['node', 'test', 'rm', 'db-1', '2']);
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('refuses JSON-mode rm without --force', async () => {
      const { setJsonMode } = await import('../../../src/lib/json-mode.js');
      setJsonMode(true);
      mockGet.mockResolvedValueOnce(listResponse());
      await expect(replicasCommand.parseAsync(['node', 'test', 'rm', 'db-1', '2'])).rejects.toThrow(/without --force/);
      expect(mockDelete).not.toHaveBeenCalled();
      setJsonMode(false);
    });
  });

  describe('status', () => {
    it('prints replication summary', async () => {
      mockGet
        .mockResolvedValueOnce(listResponse())
        .mockResolvedValueOnce({
          is_replicating: true,
          replica_count: 1,
          replicas: [{
            name: 'r1',
            node_id: 'n1',
            ready: true,
            status: 'Running',
            replication_status: 'healthy',
            seconds_behind_master: 0,
            is_replication_healthy: true,
            replica_index: 1,
          }],
        });
      await replicasCommand.parseAsync(['node', 'test', 'status', 'db-1']);
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Replicating');
      expect(output).toContain('r1');
    });
  });
});
