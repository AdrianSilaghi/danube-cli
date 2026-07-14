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

const { lsCommand, createCommand, getCommand, updateCommand, rmCommand } = await import('../../../src/commands/cache/instances.js');

class ExitError extends Error {
  constructor(public code: number) { super(`process.exit(${code})`); }
}

const makeCache = (overrides = {}) => ({
  id: 'cache-1',
  name: 'my-cache',
  status: 'running',
  status_label: 'Running',
  resource_profile: 'small',
  cpu_cores: 1,
  memory_size_mb: 1024,
  version: '7.4',
  provider_id: 'prov-1',
  provider: { id: 'prov-1', name: 'Redis', type: 'redis' as const },
  endpoint: 'my-cache.fsn1.cache.dd',
  port: 6379,
  monthly_cost_cents: 499,
  monthly_cost_dollars: '4.99',
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

describe('cache instances', () => {
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
      expect(consoleLogSpy).toHaveBeenCalledWith('No cache instances found.');
    });

    it('displays instances table', async () => {
      mockGet.mockResolvedValue({ data: [makeCache(), makeCache({ id: 'cache-2', name: 'other' })] });
      await lsCommand.parseAsync(['node', 'test']);
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('NAME');
      expect(output).toContain('my-cache');
      expect(output).toContain('other');
      expect(output).toContain('redis');
    });
  });

  describe('create', () => {
    it('creates with all flags provided', async () => {
      mockPost.mockResolvedValue({ message: 'ok', instance: makeCache() });
      await createCommand.parseAsync([
        'node', 'test',
        '--name', 'test-cache',
        '--provider', 'redis',
        '--datacenter', 'fsn1',
        '--profile', 'small',
      ]);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/cache', expect.objectContaining({
        name: 'test-cache',
        provider: 'redis',
        datacenter: 'fsn1',
        resource_profile: 'small',
      }));
    });

    it('prompts for missing name, provider, and profile', async () => {
      mockInput.mockResolvedValueOnce('prompted-cache');
      mockSelect.mockResolvedValueOnce('valkey');
      mockGet.mockResolvedValueOnce({ plans: [{ slug: 'medium', display_name: 'Medium', provider: 'valkey', cpu_cores: 1, memory_mb: 3072, storage_gb: 20, monthly_cost: 9.99 }] });
      mockSelect.mockResolvedValueOnce('medium');
      mockPost.mockResolvedValue({ message: 'ok', instance: makeCache() });

      await createCommand.parseAsync(['node', 'test']);

      expect(mockPost).toHaveBeenCalledWith('/api/v1/cache', expect.objectContaining({
        name: 'prompted-cache',
        provider: 'valkey',
        resource_profile: 'medium',
      }));
    });

    it('fetches plans from the API for the interactive picker', async () => {
      mockInput.mockResolvedValueOnce('my-cache');          // name
      mockSelect.mockResolvedValueOnce('redis');             // provider
      mockGet.mockResolvedValueOnce({ plans: [{ slug: 'small', display_name: 'Small', provider: 'redis', cpu_cores: 1, memory_mb: 1024, storage_gb: 10, monthly_cost: 4.99 }] });
      mockSelect.mockResolvedValueOnce('small');             // profile
      mockPost.mockResolvedValue({ message: 'ok', instance: makeCache() });

      await createCommand.parseAsync(['node', 'test']);

      expect(mockGet).toHaveBeenCalledWith('/api/v1/cache/plans?provider=redis');
      const planChoices = mockSelect.mock.calls.find(c => (c[0] as { message: string }).message === 'Resource profile:')![0] as { choices: Array<{ name: string; value: string }> };
      expect(planChoices.choices[0]!.name).toContain('€4.99/mo');
      expect(planChoices.choices[0]!.value).toBe('small');
    });

    it('rejects with a clear error when the API returns no plans', async () => {
      mockInput.mockResolvedValueOnce('my-cache');          // name
      mockSelect.mockResolvedValueOnce('redis');             // provider
      mockGet.mockResolvedValueOnce({ plans: [] });

      await expect(createCommand.parseAsync(['node', 'test'])).rejects.toThrow(/No .* plans/);
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('rejects invalid provider with exit 1', async () => {
      await expect(createCommand.parseAsync([
        'node', 'test', '--name', 'x', '--provider', 'memcached', '--datacenter', 'fsn1', '--profile', 'small',
      ])).rejects.toThrow(ExitError);
    });
  });

  describe('get', () => {
    it('displays instance details', async () => {
      mockGet
        .mockResolvedValueOnce({ data: [makeCache({ id: 'cache-1' })] })
        .mockResolvedValueOnce({
          instance: makeCache(),
          connection_info: 'redis://my-cache.fsn1.cache.dd:6379',
          monthly_cost: '4.99',
        });
      await getCommand.parseAsync(['node', 'test', 'cache-1']);
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('cache-1');
      expect(output).toContain('my-cache');
      expect(output).toContain('redis://my-cache.fsn1.cache.dd:6379');
    });

    it('resolves a cache instance by name', async () => {
      mockGet
        .mockResolvedValueOnce({ data: [makeCache({ id: 'cache-9', name: 'prod-cache' })] })
        .mockResolvedValueOnce({
          instance: makeCache({ id: 'cache-9', name: 'prod-cache' }),
          connection_info: 'redis://prod-cache.fsn1.cache.dd:6379',
          monthly_cost: '4.99',
        });
      await getCommand.parseAsync(['node', 'test', 'prod-cache']);
      expect(mockGet).toHaveBeenLastCalledWith('/api/v1/cache/cache-9');
    });
  });

  describe('update', () => {
    it('updates profile', async () => {
      mockGet.mockResolvedValueOnce({ data: [makeCache({ id: 'cache-1' })] });
      mockPut.mockResolvedValue({ message: 'ok', instance: makeCache({ resource_profile: 'large' }) });
      await updateCommand.parseAsync(['node', 'test', 'cache-1', '--profile', 'large']);
      expect(mockPut).toHaveBeenCalledWith('/api/v1/cache/cache-1', { resource_profile: 'large' });
    });

    it('exits when no options are passed', async () => {
      await expect(updateCommand.parseAsync(['node', 'test', 'cache-1'])).rejects.toThrow(ExitError);
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe('rm', () => {
    it('skips confirm with --force', async () => {
      mockGet.mockResolvedValueOnce({ data: [makeCache({ id: 'cache-1' })] });
      mockDelete.mockResolvedValue({ message: 'ok', status: 'destroying' });
      await rmCommand.parseAsync(['node', 'test', 'cache-1', '--force']);
      expect(mockDelete).toHaveBeenCalledWith('/api/v1/cache/cache-1');
      expect(mockConfirm).not.toHaveBeenCalled();
    });

    it('cancels when confirm returns false', async () => {
      mockGet.mockResolvedValueOnce({ data: [makeCache({ id: 'cache-1' })] });
      mockConfirm.mockResolvedValue(false);
      await rmCommand.parseAsync(['node', 'test', 'cache-1']);
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('refuses JSON-mode rm without --force', async () => {
      const { setJsonMode } = await import('../../../src/lib/json-mode.js');
      setJsonMode(true);
      mockGet.mockResolvedValueOnce({ data: [makeCache({ id: 'cache-1' })] });
      await expect(rmCommand.parseAsync(['node', 'test', 'cache-1'])).rejects.toThrow(/without --force/);
      expect(mockDelete).not.toHaveBeenCalled();
      setJsonMode(false);
    });

    it('rm gains a delete alias', () => {
      expect(rmCommand.name()).toBe('rm');
      expect(rmCommand.aliases()).toContain('delete');
    });
  });
});
