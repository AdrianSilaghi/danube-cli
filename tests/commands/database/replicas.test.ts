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

describe('database replicas', () => {
  const originalExit = process.exit;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exit = vi.fn().mockImplementation((code: number) => { throw new ExitError(code); }) as never;
    mockGet.mockReset(); mockPost.mockReset(); mockDelete.mockReset(); mockConfirm.mockReset();
  });

  afterEach(() => { process.exit = originalExit; vi.restoreAllMocks(); });

  describe('ls', () => {
    it('shows master + replicas', async () => {
      mockGet.mockResolvedValue({
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

    it('reports no replicas', async () => {
      mockGet.mockResolvedValue({
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
      mockPost.mockResolvedValue({ message: 'ok', replicas: [{ status: 'success', replica_index: 1 }] });
      await replicasCommand.parseAsync(['node', 'test', 'add', 'db-1']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/database/db-1/replicas', { replica_count: 1 });
    });

    it('adds with --count', async () => {
      mockPost.mockResolvedValue({ message: 'ok', replicas: [] });
      await replicasCommand.parseAsync(['node', 'test', 'add', 'db-1', '--count', '3']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/database/db-1/replicas', { replica_count: 3 });
    });

    it('rejects invalid --count', async () => {
      await expect(replicasCommand.parseAsync(['node', 'test', 'add', 'db-1', '--count', '0']))
        .rejects.toThrow(ExitError);
    });
  });

  describe('rm', () => {
    it('removes with --force', async () => {
      mockDelete.mockResolvedValue({ message: 'ok', status: 'success' });
      await replicasCommand.parseAsync(['node', 'test', 'rm', 'db-1', '2', '--force']);
      expect(mockDelete).toHaveBeenCalledWith('/api/v1/database/db-1/replicas/2');
    });

    it('cancels on declined confirm', async () => {
      mockConfirm.mockResolvedValue(false);
      await replicasCommand.parseAsync(['node', 'test', 'rm', 'db-1', '2']);
      expect(mockDelete).not.toHaveBeenCalled();
    });
  });

  describe('status', () => {
    it('prints replication summary', async () => {
      mockGet.mockResolvedValue({
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
