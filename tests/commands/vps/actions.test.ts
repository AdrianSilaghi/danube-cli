import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet, post: mockPost }),
  },
}));

vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  }),
}));

const mockSelect = vi.fn();
const mockConfirm = vi.fn();
vi.mock('@inquirer/prompts', () => ({
  select: (...args: unknown[]) => mockSelect(...args),
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

const { startCommand, stopCommand, rebootCommand, reinstallCommand, statusCommand, metricsCommand, passwordCommand } =
  await import('../../../src/commands/vps/actions.js');

const makeVps = (overrides = {}) => ({ id: 'vps-1', name: 'my-vps', ...overrides });
const listResponse = (overrides = {}) => ({ data: [makeVps(overrides)] });

describe('vps actions', () => {
  const originalIsTTY = process.stdin.isTTY;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mockGet.mockReset(); mockPost.mockReset(); mockSelect.mockReset(); mockConfirm.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    vi.restoreAllMocks();
  });

  it('starts a VPS', async () => {
    mockGet.mockResolvedValueOnce(listResponse());
    mockPost.mockResolvedValue({ message: 'VPS start initiated', status: 'starting' });
    await startCommand.parseAsync(['node', 'test', 'vps-1']);
    expect(mockPost).toHaveBeenCalledWith('/api/v1/vps/vps-1/start');
  });

  it('resolves a VPS by name before starting it', async () => {
    mockGet.mockResolvedValueOnce(listResponse({ id: 'vps-9', name: 'prod-web' }));
    mockPost.mockResolvedValue({ message: 'VPS start initiated', status: 'starting' });
    await startCommand.parseAsync(['node', 'test', 'prod-web']);
    expect(mockPost).toHaveBeenCalledWith('/api/v1/vps/vps-9/start');
  });

  it('stops a VPS', async () => {
    mockGet.mockResolvedValueOnce(listResponse());
    mockPost.mockResolvedValue({ message: 'VPS stop initiated', status: 'stopping' });
    await stopCommand.parseAsync(['node', 'test', 'vps-1']);
    expect(mockPost).toHaveBeenCalledWith('/api/v1/vps/vps-1/stop');
  });

  it('reboots a VPS', async () => {
    mockGet.mockResolvedValueOnce(listResponse());
    mockPost.mockResolvedValue({ message: 'VPS reboot initiated', status: 'rebooting' });
    await rebootCommand.parseAsync(['node', 'test', 'vps-1']);
    expect(mockPost).toHaveBeenCalledWith('/api/v1/vps/vps-1/reboot');
  });

  it('reinstalls a VPS with --image and --force', async () => {
    mockGet.mockResolvedValueOnce(listResponse());
    mockPost.mockResolvedValue({ message: 'VPS reinstall initiated', status: 'reinstalling' });
    await reinstallCommand.parseAsync(['node', 'test', 'vps-1', '--image', 'debian-12', '--force']);
    expect(mockPost).toHaveBeenCalledWith('/api/v1/vps/vps-1/reinstall', { image: 'debian-12' });
  });

  it('cancels reinstall when user declines', async () => {
    mockGet
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce({ groups: [{ distro: 'ubuntu', name: 'Ubuntu', images: [{ id: 'ubuntu-24.04', label: 'Ubuntu 24.04', default_user: 'root' }] }] });
    mockSelect.mockResolvedValue('ubuntu-24.04');
    mockConfirm.mockResolvedValue(false);
    await reinstallCommand.parseAsync(['node', 'test', 'vps-1']);
    expect(consoleLogSpy).toHaveBeenCalledWith('Cancelled.');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('shows VPS status', async () => {
    mockGet
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce({
        status: 'running', status_label: 'Running', status_color: 'green',
        can_be_started: false, can_be_stopped: true, can_be_rebooted: true,
        can_be_destroyed: true, is_transitional: false, updated_at: '2024-01-01T00:00:00Z',
      });
    await statusCommand.parseAsync(['node', 'test', 'vps-1']);
    expect(mockGet).toHaveBeenLastCalledWith('/api/v1/vps/vps-1/status');
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Running'));
  });

  it('shows VPS metrics', async () => {
    mockGet
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce({
        cpu: { usage_percent: 25, cores: 2, sockets: 1, threads: 2 },
        memory: { used_gb: 1, total_gb: 2, usage_percent: 50 },
        storage: { used_gb: 10, total_gb: 40, usage_percent: 25 },
        network: { rx_bytes: 1048576, tx_bytes: 524288, rx_packets: 1000, tx_packets: 500 },
        uptime_seconds: 86400, timestamp: '2024-01-01T00:00:00Z',
      });
    await metricsCommand.parseAsync(['node', 'test', 'vps-1']);
    expect(mockGet).toHaveBeenLastCalledWith('/api/v1/vps/vps-1/metrics');
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('25%'));
  });

  it('shows VPS password after confirmation', async () => {
    mockConfirm.mockResolvedValue(true);
    mockGet
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce({ password: 'MySecretPass123!', username: 'root', public_ip: '1.2.3.4' });
    await passwordCommand.parseAsync(['node', 'test', 'vps-1']);
    expect(mockGet).toHaveBeenLastCalledWith('/api/v1/vps/vps-1/password');
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('MySecretPass123!'));
  });

  it('cancels password display when user declines', async () => {
    mockGet.mockResolvedValueOnce(listResponse());
    mockConfirm.mockResolvedValue(false);
    await passwordCommand.parseAsync(['node', 'test', 'vps-1']);
    expect(consoleLogSpy).toHaveBeenCalledWith('Cancelled.');
    // Resolution (list) happens before the confirm, but the password reveal itself must not.
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('refuses JSON-mode password reveal without --force', async () => {
    const { setJsonMode } = await import('../../../src/lib/json-mode.js');
    setJsonMode(true);
    mockGet.mockResolvedValueOnce(listResponse());
    await expect(passwordCommand.parseAsync(['node', 'test', 'vps-1'])).rejects.toThrow(/without --force/);
    expect(mockGet).toHaveBeenCalledTimes(1);
    setJsonMode(false);
  });
});
