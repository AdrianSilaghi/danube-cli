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
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exit = vi.fn().mockImplementation((code: number) => { throw new ExitError(code); }) as never;
    mockGet.mockReset(); mockPost.mockReset(); mockPut.mockReset(); mockDelete.mockReset();
    mockInput.mockReset(); mockSelect.mockReset(); mockConfirm.mockReset(); mockPassword.mockReset();
  });

  afterEach(() => { process.exit = originalExit; vi.restoreAllMocks(); });

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
  });

  describe('get', () => {
    it('displays instance details', async () => {
      mockGet.mockResolvedValue({
        instance: makeVps(),
        connection_info: { ssh_user: 'root', ssh_port: 22, public_ip: '1.2.3.4', ipv6_address: null, vnc_url: null },
        monthly_cost: 4.49,
      });

      await getCommand.parseAsync(['node', 'test', 'vps-1']);

      expect(mockGet).toHaveBeenCalledWith('/api/v1/vps/vps-1');
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('my-vps'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('ssh root@1.2.3.4'));
    });
  });

  describe('update', () => {
    it('updates VPS with flags', async () => {
      mockPut.mockResolvedValue({ message: 'Updated', instance: makeVps() });

      await updateCommand.parseAsync(['node', 'test', 'vps-1', '--cpu-cores', '4', '--memory', '8']);

      expect(mockPut).toHaveBeenCalledWith('/api/v1/vps/vps-1', { cpu_cores: 4, memory_size_gb: 8 });
    });

    it('exits when no flags provided', async () => {
      await expect(updateCommand.parseAsync(['node', 'test', 'vps-1'])).rejects.toThrow(ExitError);
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  describe('delete', () => {
    it('deletes with --force', async () => {
      mockDelete.mockResolvedValue({ message: 'Deleted' });
      await deleteCommand.parseAsync(['node', 'test', 'vps-1', '--force']);
      expect(mockDelete).toHaveBeenCalledWith('/api/v1/vps/vps-1');
    });

    it('cancels when user declines', async () => {
      mockConfirm.mockResolvedValue(false);
      await deleteCommand.parseAsync(['node', 'test', 'vps-1']);
      expect(consoleLogSpy).toHaveBeenCalledWith('Cancelled.');
      expect(mockDelete).not.toHaveBeenCalled();
    });
  });
});
