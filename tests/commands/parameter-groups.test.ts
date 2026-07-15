import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPut = vi.fn();
const mockDelete = vi.fn();
vi.mock('../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet, post: mockPost, put: mockPut, delete: mockDelete }),
  },
}));

vi.mock('ora', () => ({
  default: () => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis() }),
}));

const mockConfirm = vi.fn();
vi.mock('@inquirer/prompts', () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

const { parameterGroupsCommand } = await import('../../src/commands/parameter-groups.js');

class ExitError extends Error {
  constructor(public code: number) { super(`process.exit(${code})`); }
}

const makeGroup = (overrides = {}) => ({
  id: 1,
  name: 'my-group',
  type: 'cache' as const,
  provider_type: 'redis',
  family: 'redis7.x',
  description: null,
  parameters: { 'maxmemory-policy': 'allkeys-lru' },
  locked_parameters: ['maxmemory-policy'],
  team_id: 1,
  is_default: false,
  is_active: true,
  is_system: false,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('parameter-groups command', () => {
  const originalExit = process.exit;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exit = vi.fn().mockImplementation((code: number) => { throw new ExitError(code); }) as never;
    mockGet.mockReset(); mockPost.mockReset(); mockPut.mockReset(); mockDelete.mockReset(); mockConfirm.mockReset();
  });

  afterEach(() => { process.exit = originalExit; vi.restoreAllMocks(); });

  describe('ls', () => {
    it('lists groups with optional filters', async () => {
      mockGet.mockResolvedValue({ data: [makeGroup(), makeGroup({ id: 2, name: 'sys', is_system: true })] });
      await parameterGroupsCommand.parseAsync(['node', 'test', 'ls', '--type', 'cache', '--provider', 'redis']);
      expect(mockGet).toHaveBeenCalledWith('/api/v1/parameter-groups?type=cache&provider_type=redis&per_page=100&page=1');
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('my-group');
      expect(output).toContain('sys');
    });

    it('rejects invalid --type', async () => {
      await expect(parameterGroupsCommand.parseAsync(['node', 'test', 'ls', '--type', 'bogus']))
        .rejects.toThrow(ExitError);
    });

    it('shows a truncation note alongside an existing query filter', async () => {
      mockGet.mockResolvedValue({
        data: [makeGroup()],
        pagination: { current_page: 1, last_page: 1, per_page: 100, total: 30 },
      });
      await parameterGroupsCommand.parseAsync(['node', 'test', 'ls', '--type', 'cache']);
      expect(mockGet).toHaveBeenCalledWith('/api/v1/parameter-groups?type=cache&per_page=100&page=1');
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Showing 1 of 30');
    });
  });

  describe('create', () => {
    it('posts with parsed JSON parameters and locked keys', async () => {
      mockPost.mockResolvedValue({ message: 'ok', parameter_group: makeGroup() });
      await parameterGroupsCommand.parseAsync([
        'node', 'test', 'create',
        '--name', 'my-group',
        '--type', 'cache',
        '--provider', 'redis',
        '--parameters', '{"maxmemory-policy":"allkeys-lru"}',
        '--locked', 'maxmemory-policy,maxclients',
      ]);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/parameter-groups', expect.objectContaining({
        name: 'my-group',
        type: 'cache',
        provider_type: 'redis',
        parameters: { 'maxmemory-policy': 'allkeys-lru' },
        locked_parameters: ['maxmemory-policy', 'maxclients'],
      }));
    });

    it('exits when required flags are missing', async () => {
      await expect(parameterGroupsCommand.parseAsync(['node', 'test', 'create', '--name', 'x']))
        .rejects.toThrow(ExitError);
    });
  });

  describe('get', () => {
    it('prints details and parameters', async () => {
      mockGet.mockResolvedValue({ parameter_group: makeGroup() });
      await parameterGroupsCommand.parseAsync(['node', 'test', 'get', '1']);
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('my-group');
      expect(output).toContain('maxmemory-policy = allkeys-lru');
      expect(output).toContain('[locked]');
    });
  });

  describe('update', () => {
    it('sends only provided fields', async () => {
      mockPut.mockResolvedValue({ message: 'ok', parameter_group: makeGroup() });
      await parameterGroupsCommand.parseAsync(['node', 'test', 'update', '1', '--name', 'renamed']);
      expect(mockPut).toHaveBeenCalledWith('/api/v1/parameter-groups/1', { name: 'renamed' });
    });

    it('exits when no options provided', async () => {
      await expect(parameterGroupsCommand.parseAsync(['node', 'test', 'update', '1']))
        .rejects.toThrow(ExitError);
    });
  });

  describe('rm', () => {
    it('deletes with --force', async () => {
      mockDelete.mockResolvedValue({ message: 'ok' });
      await parameterGroupsCommand.parseAsync(['node', 'test', 'rm', '1', '--force']);
      expect(mockDelete).toHaveBeenCalledWith('/api/v1/parameter-groups/1');
    });

    it('refuses JSON-mode rm without --force', async () => {
      const { setJsonMode } = await import('../../src/lib/json-mode.js');
      setJsonMode(true);
      await expect(parameterGroupsCommand.parseAsync(['node', 'test', 'rm', '1']))
        .rejects.toThrow(/without --force/);
      expect(mockDelete).not.toHaveBeenCalled();
      setJsonMode(false);
    });
  });

  describe('clone', () => {
    it('clones with --name', async () => {
      mockPost.mockResolvedValue({ message: 'ok', parameter_group: makeGroup({ id: 2, name: 'clone' }) });
      await parameterGroupsCommand.parseAsync(['node', 'test', 'clone', '1', '--name', 'clone']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/parameter-groups/1/clone', { name: 'clone' });
    });

    it('clones without --name (empty body)', async () => {
      mockPost.mockResolvedValue({ message: 'ok', parameter_group: makeGroup({ id: 2 }) });
      await parameterGroupsCommand.parseAsync(['node', 'test', 'clone', '1']);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/parameter-groups/1/clone', {});
    });
  });
});
