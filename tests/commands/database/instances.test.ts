import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPut = vi.fn();
const mockDelete = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet, post: mockPost, put: mockPut, delete: mockDelete }),
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
const mockSelect = vi.fn();
const mockConfirm = vi.fn();
vi.mock('@inquirer/prompts', () => ({
  input: (...args: unknown[]) => mockInput(...args),
  select: (...args: unknown[]) => mockSelect(...args),
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

const { lsCommand, createCommand, getCommand, updateCommand, rmCommand } = await import('../../../src/commands/database/instances.js');

class ExitError extends Error {
  constructor(public code: number) { super(`process.exit(${code})`); }
}

const makeDatabase = (overrides = {}) => ({
  id: 'db-1',
  name: 'my-db',
  status: 'running',
  status_label: 'Running',
  resource_profile: 'small',
  cpu_cores: 1,
  memory_size_mb: 2048,
  storage_size_gb: 20,
  version: '8.0',
  datacenter: 'fsn1',
  provider_id: 'prov-1',
  provider: { id: 'prov-1', name: 'MySQL', type: 'mysql' as const },
  engine: { id: 'prov-1', name: 'mysql' as const },
  endpoint: 'my-db.fsn1.db.dd',
  port: 3306,
  username: 'root',
  monthly_cost_cents: 1999,
  monthly_cost_dollars: '19.99',
  deployed_at: '2024-01-01T00:00:00Z',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  team_id: 1,
  user_id: 1,
  can_be_started: false,
  can_be_stopped: true,
  can_be_destroyed: true,
  ...overrides,
});

describe('database instances', () => {
  const originalExit = process.exit;
  const originalIsTTY = process.stdin.isTTY;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exit = vi.fn().mockImplementation((code: number) => { throw new ExitError(code); }) as never;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mockGet.mockReset(); mockPost.mockReset(); mockPut.mockReset(); mockDelete.mockReset();
    mockInput.mockReset(); mockSelect.mockReset(); mockConfirm.mockReset();
  });

  afterEach(() => {
    process.exit = originalExit;
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    vi.restoreAllMocks();
  });

  describe('ls', () => {
    it('shows message when no instances', async () => {
      mockGet.mockResolvedValue({ data: [] });
      await lsCommand.parseAsync(['node', 'test']);
      expect(consoleLogSpy).toHaveBeenCalledWith('No database instances found.');
    });

    it('displays table', async () => {
      mockGet.mockResolvedValue({ data: [makeDatabase(), makeDatabase({ id: 'db-2', name: 'pg', provider: { id: 'prov-2', name: 'PG', type: 'postgresql' as const } })] });
      await lsCommand.parseAsync(['node', 'test']);
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('my-db');
      expect(output).toContain('mysql');
      expect(output).toContain('postgresql');
    });
  });

  describe('create', () => {
    it('creates with all flags', async () => {
      mockPost.mockResolvedValue({ message: 'ok', instance: makeDatabase() });
      await createCommand.parseAsync([
        'node', 'test', '--name', 'test-db', '--provider', 'mysql',
        '--datacenter', 'fsn1', '--profile', 'small',
      ]);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/database', expect.objectContaining({
        name: 'test-db', provider: 'mysql', datacenter: 'fsn1', resource_profile: 'small',
      }));
    });

    it('includes database_name when provided', async () => {
      mockPost.mockResolvedValue({ message: 'ok', instance: makeDatabase() });
      await createCommand.parseAsync([
        'node', 'test', '--name', 'd', '--provider', 'postgresql',
        '--datacenter', 'fsn1', '--profile', 'small', '--database-name', 'app',
      ]);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/database', expect.objectContaining({ database_name: 'app' }));
    });

    it('rejects invalid provider', async () => {
      await expect(createCommand.parseAsync([
        'node', 'test', '--name', 'x', '--provider', 'oracle', '--datacenter', 'fsn1', '--profile', 'small',
      ])).rejects.toThrow(ExitError);
    });

    it('rejects invalid datacenter', async () => {
      await expect(createCommand.parseAsync([
        'node', 'test', '--name', 'x', '--provider', 'mysql', '--datacenter', 'ash', '--profile', 'small',
      ])).rejects.toThrow(ExitError);
    });
  });

  describe('get', () => {
    it('displays details', async () => {
      mockGet
        .mockResolvedValueOnce({ data: [makeDatabase({ id: 'db-1' })] })
        .mockResolvedValueOnce({
          instance: makeDatabase(),
          connection_info: 'mysql://root@my-db.fsn1.db.dd:3306',
          monthly_cost: '19.99',
        });
      await getCommand.parseAsync(['node', 'test', 'db-1']);
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('db-1');
      expect(output).toContain('mysql://root@my-db.fsn1.db.dd:3306');
    });

    it('resolves a database instance by name', async () => {
      mockGet
        .mockResolvedValueOnce({ data: [makeDatabase({ id: 'db-9', name: 'prod-db' })] })
        .mockResolvedValueOnce({
          instance: makeDatabase({ id: 'db-9', name: 'prod-db' }),
          connection_info: 'mysql://root@prod-db.fsn1.db.dd:3306',
          monthly_cost: '19.99',
        });
      await getCommand.parseAsync(['node', 'test', 'prod-db']);
      expect(mockGet).toHaveBeenLastCalledWith('/api/v1/database/db-9');
    });
  });

  describe('update', () => {
    it('updates profile', async () => {
      mockGet.mockResolvedValueOnce({ data: [makeDatabase({ id: 'db-1' })] });
      mockPut.mockResolvedValue({ message: 'ok', instance: makeDatabase({ resource_profile: 'large' }) });
      await updateCommand.parseAsync(['node', 'test', 'db-1', '--profile', 'large']);
      expect(mockPut).toHaveBeenCalledWith('/api/v1/database/db-1', { resource_profile: 'large' });
    });

    it('exits without options', async () => {
      await expect(updateCommand.parseAsync(['node', 'test', 'db-1'])).rejects.toThrow(ExitError);
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe('rm', () => {
    it('skips confirm with --force', async () => {
      mockGet.mockResolvedValueOnce({ data: [makeDatabase({ id: 'db-1' })] });
      mockDelete.mockResolvedValue({ message: 'ok', status: 'destroying' });
      await rmCommand.parseAsync(['node', 'test', 'db-1', '--force']);
      expect(mockDelete).toHaveBeenCalledWith('/api/v1/database/db-1');
    });

    it('cancels when confirm returns false', async () => {
      mockGet.mockResolvedValueOnce({ data: [makeDatabase({ id: 'db-1' })] });
      mockConfirm.mockResolvedValue(false);
      await rmCommand.parseAsync(['node', 'test', 'db-1']);
      expect(consoleLogSpy).toHaveBeenCalledWith('Cancelled.');
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('refuses JSON-mode rm without --force', async () => {
      const { setJsonMode } = await import('../../../src/lib/json-mode.js');
      setJsonMode(true);
      mockGet.mockResolvedValueOnce({ data: [makeDatabase({ id: 'db-1' })] });
      await expect(rmCommand.parseAsync(['node', 'test', 'db-1'])).rejects.toThrow(/without --force/);
      expect(mockDelete).not.toHaveBeenCalled();
      setJsonMode(false);
    });
  });
});
