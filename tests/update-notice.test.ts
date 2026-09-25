import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCheckForUpdate = vi.fn();
const mockPrintUpdateNotification = vi.fn();
const mockPrintAutoUpdateNotice = vi.fn();
vi.mock('../src/lib/version.js', () => ({
  checkForUpdate: (...args: unknown[]) => mockCheckForUpdate(...args),
  printUpdateNotification: (...args: unknown[]) => mockPrintUpdateNotification(...args),
  printAutoUpdateNotice: (...args: unknown[]) => mockPrintAutoUpdateNotice(...args),
}));

const mockReadConfig = vi.fn();
vi.mock('../src/lib/config.js', () => ({
  readConfig: () => mockReadConfig(),
}));

const mockPerformUpgrade = vi.fn();
vi.mock('../src/lib/upgrade.js', () => ({
  performUpgrade: (...args: unknown[]) => mockPerformUpgrade(...args),
}));

const {
  wantsUpdateNotice,
  prepareUpdateNotice,
  autoUpdateIfEnabled,
  STARTUP_CHECK_TIMEOUT_MS,
} = await import('../src/lib/update-notice.js');

const minor = { current: '1.5.0', latest: '1.6.0', updateAvailable: true, isMajor: false };
const major = { current: '1.6.0', latest: '2.0.0', updateAvailable: true, isMajor: true };
const upToDate = { current: '1.6.0', latest: '1.6.0', updateAvailable: false, isMajor: false };

describe('update notice', () => {
  beforeEach(() => {
    mockCheckForUpdate.mockReset();
    mockPrintUpdateNotification.mockReset();
    mockPrintAutoUpdateNotice.mockReset();
    mockReadConfig.mockReset();
    mockPerformUpgrade.mockReset();
  });

  describe('wantsUpdateNotice', () => {
    /**
     * The point of the change: opening the CLI at all — no command, --help,
     * a failing command — is when someone should hear a newer version exists.
     */
    it.each([
      [[]],
      [['--help']],
      [['--version']],
      [['pages', 'deploy']],
      [['--project', '4', 'pages', 'deploy']],
      [['--', 'upgrade']],
    ])('notifies a person at a terminal: %j', (argv) => {
      expect(wantsUpdateNotice(argv, true)).toBe(true);
    });

    it('stays out of redirected output', () => {
      expect(wantsUpdateNotice(['pages', 'deploy'], false)).toBe(false);
    });

    it('stays out of JSON mode, wherever the flag is', () => {
      expect(wantsUpdateNotice(['pages', 'deploy', '--json'], true)).toBe(false);
      expect(wantsUpdateNotice(['--json', 'vps', 'ls'], true)).toBe(false);
    });

    it('leaves `danube upgrade` to report on itself', () => {
      expect(wantsUpdateNotice(['upgrade'], true)).toBe(false);
      expect(wantsUpdateNotice(['--team', '4', 'upgrade', '--check'], true)).toBe(false);
    });
  });

  describe('prepareUpdateNotice', () => {
    it('checks once, with the short startup timeout', async () => {
      mockCheckForUpdate.mockResolvedValue(minor);

      const notice = await prepareUpdateNotice(['whoami'], true);

      expect(mockCheckForUpdate).toHaveBeenCalledOnce();
      expect(mockCheckForUpdate).toHaveBeenCalledWith({ timeoutMs: STARTUP_CHECK_TIMEOUT_MS });
      expect(notice.result).toBe(minor);
    });

    it('does not even check when the notice is not wanted', async () => {
      const notice = await prepareUpdateNotice(['--json', 'whoami'], true);
      notice.print();

      expect(mockCheckForUpdate).not.toHaveBeenCalled();
      expect(notice.result).toBeNull();
      expect(mockPrintUpdateNotification).not.toHaveBeenCalled();
    });

    it('prints exactly once, however many exit paths call it', async () => {
      mockCheckForUpdate.mockResolvedValue(minor);
      const notice = await prepareUpdateNotice([], true);

      notice.print();
      notice.print();

      expect(mockPrintUpdateNotification).toHaveBeenCalledOnce();
      expect(mockPrintUpdateNotification).toHaveBeenCalledWith('1.5.0', '1.6.0', false);
    });

    it('announces a major upgrade as major', async () => {
      mockCheckForUpdate.mockResolvedValue(major);
      const notice = await prepareUpdateNotice([], true);

      notice.print();

      expect(mockPrintUpdateNotification).toHaveBeenCalledWith('1.6.0', '2.0.0', true);
    });

    it('prints nothing when already up to date or when the check failed', async () => {
      mockCheckForUpdate.mockResolvedValueOnce(upToDate).mockResolvedValueOnce(null);

      (await prepareUpdateNotice([], true)).print();
      (await prepareUpdateNotice([], true)).print();

      expect(mockPrintUpdateNotification).not.toHaveBeenCalled();
    });

    it('prints nothing once dismissed', async () => {
      mockCheckForUpdate.mockResolvedValue(minor);
      const notice = await prepareUpdateNotice([], true);

      notice.dismiss();
      notice.print();

      expect(mockPrintUpdateNotification).not.toHaveBeenCalled();
    });

    it('defaults to asking whether stderr is a terminal', async () => {
      const original = process.stderr.isTTY;
      Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
      try {
        await prepareUpdateNotice([]);
        expect(mockCheckForUpdate).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process.stderr, 'isTTY', { value: original, configurable: true });
      }
    });
  });

  describe('autoUpdateIfEnabled', () => {
    const noticeFor = async (result: unknown) => {
      mockCheckForUpdate.mockResolvedValue(result);
      return prepareUpdateNotice([], true);
    };

    it('installs a same-major update when opted in, replacing the notice', async () => {
      const notice = await noticeFor(minor);
      mockReadConfig.mockResolvedValue({ token: 't', autoUpdate: true });
      mockPerformUpgrade.mockResolvedValue({ ok: true, from: '1.5.0', to: '1.6.0', message: 'Upgraded' });

      await autoUpdateIfEnabled(notice);
      notice.print();

      expect(mockPerformUpgrade).toHaveBeenCalledWith('1.5.0', '1.6.0');
      expect(mockPrintAutoUpdateNotice).toHaveBeenCalledWith('1.5.0', '1.6.0');
      expect(mockPrintUpdateNotification).not.toHaveBeenCalled();
    });

    it('never installs a major upgrade', async () => {
      const notice = await noticeFor(major);
      mockReadConfig.mockResolvedValue({ token: 't', autoUpdate: true });

      await autoUpdateIfEnabled(notice);

      expect(mockReadConfig).not.toHaveBeenCalled();
      expect(mockPerformUpgrade).not.toHaveBeenCalled();
    });

    it('does nothing unless opted in', async () => {
      const notice = await noticeFor(minor);
      mockReadConfig.mockResolvedValue({ token: 't' });

      await autoUpdateIfEnabled(notice);

      expect(mockPerformUpgrade).not.toHaveBeenCalled();
    });

    it('treats an unreadable config as not opted in', async () => {
      const notice = await noticeFor(minor);
      mockReadConfig.mockRejectedValue(new Error('EACCES'));

      await autoUpdateIfEnabled(notice);

      expect(mockPerformUpgrade).not.toHaveBeenCalled();
    });

    it('falls back to the notice when the install is refused', async () => {
      const notice = await noticeFor(minor);
      mockReadConfig.mockResolvedValue({ token: 't', autoUpdate: true });
      mockPerformUpgrade.mockResolvedValue({ ok: false, from: '1.5.0', to: '1.6.0', message: 'managed by volta' });

      await autoUpdateIfEnabled(notice);
      notice.print();

      expect(mockPrintAutoUpdateNotice).not.toHaveBeenCalled();
      expect(mockPrintUpdateNotification).toHaveBeenCalledOnce();
    });

    it('does nothing when there is no update', async () => {
      const notice = await noticeFor(upToDate);

      await autoUpdateIfEnabled(notice);

      expect(mockReadConfig).not.toHaveBeenCalled();
    });
  });
});
