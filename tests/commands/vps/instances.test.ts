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
const mockPassword = vi.fn();
vi.mock('@inquirer/prompts', () => ({
  input: (...args: unknown[]) => mockInput(...args),
  select: (...args: unknown[]) => mockSelect(...args),
  confirm: (...args: unknown[]) => mockConfirm(...args),
  password: (...args: unknown[]) => mockPassword(...args),
}));

const { lsCommand, createCommand, getCommand, updateCommand, deleteCommand } = await import('../../../src/commands/vps/instances.js');

class ExitError extends Error {
  constructor(public code: number) { super(`process.exit(${code})`); }
}

const makeVps = (overrides = {}) => ({
  id: 'vps-1', name: 'my-vps', status: 'running', status_label: 'Running',
  resource_profile: 'nano_shared', cpu_allocation_type: 'shared', cpu_cores: 2,
  memory_size_gb: 2, storage_size_gb: 40, image: 'ubuntu-24.04', datacenter: 'fsn1',
  public_ip: '1.2.3.4', ipv6_address: null, vnc_access_url: null,
  monthly_cost_cents: 449, monthly_cost_dollars: 4.49,
  deployed_at: '2024-01-01T00:00:00Z', created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z', team_id: 'team-1', user_id: 'user-1',
  ssh_key_id: null, can_be_started: false, can_be_stopped: true,
  can_be_rebooted: true, can_be_destroyed: true,
  ...overrides,
});

describe('vps instances', () => {
  const originalExit = process.exit;
  const originalIsTTY = process.stdin.isTTY;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exit = vi.fn().mockImplementation((code: number) => { throw new ExitError(code); }) as never;
    // Prompt-driven paths need a "TTY" so canPrompt() lets them through.
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mockGet.mockReset(); mockPost.mockReset(); mockPut.mockReset(); mockDelete.mockReset();
    mockInput.mockReset(); mockSelect.mockReset(); mockConfirm.mockReset(); mockPassword.mockReset();
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
      expect(consoleLogSpy).toHaveBeenCalledWith('No VPS instances found.');
    });

    it('displays instances table', async () => {
      mockGet.mockResolvedValue({ data: [makeVps(), makeVps({ id: 'vps-2', name: 'other' })] });
      await lsCommand.parseAsync(['node', 'test']);
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('NAME'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('my-vps'));
    });

    it('fetches every page and shows a truncation note when capped', async () => {
      mockGet.mockResolvedValue({
        data: [makeVps()],
        pagination: { current_page: 1, last_page: 1, per_page: 100, total: 250 },
      });
      await lsCommand.parseAsync(['node', 'test']);
      expect(mockGet).toHaveBeenCalledWith('/api/v1/vps?per_page=100&page=1');
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Showing 1 of 250');
    });
  });

  describe('create', () => {
    it('creates VPS with flags', async () => {
      mockPost.mockResolvedValue({ message: 'Created', instance: makeVps({ name: 'test-vps' }) });

      await createCommand.parseAsync([
        'node', 'test',
        '--name', 'test-vps', '--image', 'ubuntu-24.04', '--plan', 'nano_shared',
        '--ssh-key-id', 'key-1', '--datacenter', 'fsn1',
      ]);

      expect(mockPost).toHaveBeenCalledWith('/api/v1/vps', expect.objectContaining({
        name: 'test-vps', image: 'ubuntu-24.04', resource_profile: 'nano_shared',
        ssh_key_id: 'key-1', auth_method: 'ssh_key',
      }));
    });

    it('creates VPS with password auth', async () => {
      mockPost.mockResolvedValue({ message: 'Created', instance: makeVps() });

      await createCommand.parseAsync([
        'node', 'test',
        '--name', 'pw-vps', '--image', 'ubuntu-24.04', '--plan', 'nano_shared',
        '--password', 'MyStr0ngP@ssw0rd!',
      ]);

      expect(mockPost).toHaveBeenCalledWith('/api/v1/vps', expect.objectContaining({
        auth_method: 'password', password: 'MyStr0ngP@ssw0rd!',
        password_confirmation: 'MyStr0ngP@ssw0rd!',
      }));
    });

    it('fetches plans from the API for the interactive picker', async () => {
      mockGet
        .mockResolvedValueOnce({ groups: [{ label: 'Ubuntu', images: [{ id: 'ubuntu-24.04', label: 'Ubuntu 24.04', default_user: 'root' }] }] })
        .mockResolvedValueOnce({ plans: [{ slug: 'nano_shared', display_name: 'DD Litcov', type: 'shared', cpu_cores: 2, memory_gb: 2, storage_gb: 40, monthly_cost: 4.49 }] });
      mockInput.mockResolvedValueOnce('my-vps');           // name
      mockSelect
        .mockResolvedValueOnce('ubuntu-24.04')             // image
        .mockResolvedValueOnce('nano_shared')              // plan
        .mockResolvedValueOnce('ssh_key');                 // auth method
      mockInput.mockResolvedValueOnce('key-1');            // ssh key id
      mockPost.mockResolvedValue({ message: 'ok', instance: makeVps() });

      await createCommand.parseAsync(['node', 'test']);

      expect(mockGet).toHaveBeenCalledWith('/api/v1/vps/plans');
      const planChoices = mockSelect.mock.calls.find(c => (c[0] as { message: string }).message === 'Plan:')![0] as { choices: Array<{ name: string; value: string }> };
      expect(planChoices.choices[0]!.name).toContain('€4.49/mo');
      expect(planChoices.choices[0]!.value).toBe('nano_shared');
    });

    it('rejects with a clear error when the API returns no plans', async () => {
      mockGet
        .mockResolvedValueOnce({ groups: [{ label: 'Ubuntu', images: [{ id: 'ubuntu-24.04', label: 'Ubuntu 24.04', default_user: 'root' }] }] })
        .mockResolvedValueOnce({ plans: [] });
      mockInput.mockResolvedValueOnce('my-vps');           // name
      mockSelect.mockResolvedValueOnce('ubuntu-24.04');    // image

      await expect(createCommand.parseAsync(['node', 'test'])).rejects.toThrow(/No .* plans/);
      expect(mockPost).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('displays instance details', async () => {
      mockGet
        .mockResolvedValueOnce({ data: [makeVps({ id: 'vps-1' })] })
        .mockResolvedValueOnce({
          instance: makeVps(),
          connection_info: { public_ip: '1.2.3.4', private_ip: null, ipv6_address: null, vnc_access_url: null },
          monthly_cost: 4.49,
        });

      await getCommand.parseAsync(['node', 'test', 'vps-1']);

      expect(mockGet).toHaveBeenLastCalledWith('/api/v1/vps/vps-1');
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('my-vps'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('ssh root@1.2.3.4'));
    });

    it('resolves a VPS by name', async () => {
      mockGet
        .mockResolvedValueOnce({ data: [makeVps({ id: 'vps-9', name: 'prod-web' })] })
        .mockResolvedValueOnce({
          instance: makeVps({ id: 'vps-9', name: 'prod-web' }),
          connection_info: { public_ip: '1.2.3.4', private_ip: null, ipv6_address: null, vnc_access_url: null },
          monthly_cost: 4.49,
        });

      await getCommand.parseAsync(['node', 'test', 'prod-web']);

      expect(mockGet).toHaveBeenLastCalledWith('/api/v1/vps/vps-9');
    });

    it('shows private IP and internal DNS from connection_info', async () => {
      mockGet
        .mockResolvedValueOnce({ data: [makeVps()] })
        .mockResolvedValueOnce({
          instance: makeVps(),
          connection_info: { public_ip: '1.2.3.4', private_ip: '10.0.0.5', ipv6_address: null, vnc_access_url: null, internal_dns: 'vm-abc', internal_fqdn: 'vm-abc.tenant-1.svc.cluster.local' },
          monthly_cost: 4.49,
        });
      await getCommand.parseAsync(['node', 'test', 'vps-1']);
      const all = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(all).toContain('10.0.0.5');
      expect(all).toContain('vm-abc.tenant-1.svc.cluster.local');
    });
  });

  describe('update', () => {
    it('updates VPS with flags', async () => {
      mockGet.mockResolvedValueOnce({ data: [makeVps({ id: 'vps-1' })] });
      mockPut.mockResolvedValue({ message: 'Updated', instance: makeVps() });

      await updateCommand.parseAsync(['node', 'test', 'vps-1', '--cpu-cores', '4', '--memory', '8']);

      expect(mockPut).toHaveBeenCalledWith('/api/v1/vps/vps-1', { cpu_cores: 4, memory_size_gb: 8 });
    });

    it('exits when no flags provided', async () => {
      await expect(updateCommand.parseAsync(['node', 'test', 'vps-1'])).rejects.toThrow(ExitError);
      expect(process.exit).toHaveBeenCalledWith(1);
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('deletes with --force', async () => {
      mockGet.mockResolvedValueOnce({ data: [makeVps({ id: 'vps-1' })] });
      mockDelete.mockResolvedValue({ message: 'Deleted' });
      await deleteCommand.parseAsync(['node', 'test', 'vps-1', '--force']);
      expect(mockDelete).toHaveBeenCalledWith('/api/v1/vps/vps-1');
    });

    it('cancels when user declines', async () => {
      mockGet.mockResolvedValueOnce({ data: [makeVps({ id: 'vps-1' })] });
      mockConfirm.mockResolvedValue(false);
      await deleteCommand.parseAsync(['node', 'test', 'vps-1']);
      expect(consoleLogSpy).toHaveBeenCalledWith('Cancelled.');
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('refuses JSON-mode delete without --force', async () => {
      const { setJsonMode } = await import('../../../src/lib/json-mode.js');
      setJsonMode(true);
      mockGet.mockResolvedValueOnce({ data: [makeVps()] });
      await expect(deleteCommand.parseAsync(['node', 'test', 'vps-1'])).rejects.toThrow(/without --force/);
      expect(mockDelete).not.toHaveBeenCalled();
      setJsonMode(false);
    });

    it('delete is canonical rm with delete alias', () => {
      expect(deleteCommand.name()).toBe('rm');
      expect(deleteCommand.aliases()).toContain('delete');
    });
  });
});
