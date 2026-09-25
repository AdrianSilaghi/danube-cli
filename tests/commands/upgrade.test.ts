import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockCheckForUpdate = vi.fn();
vi.mock('../../src/lib/version.js', () => ({
  PACKAGE_NAME: '@danubedata/cli',
  getCurrentVersion: () => '1.5.1',
  checkForUpdate: (...args: unknown[]) => mockCheckForUpdate(...args),
}));

const mockDetectInstall = vi.fn();
const mockPerformUpgrade = vi.fn();
vi.mock('../../src/lib/upgrade.js', () => ({
  detectInstall: () => mockDetectInstall(),
  explainRefusal: (install: { kind: string }) => `refused: ${install.kind}`,
  performUpgrade: (...args: unknown[]) => mockPerformUpgrade(...args),
}));

const mockReadConfig = vi.fn();
const mockWriteConfig = vi.fn();
vi.mock('../../src/lib/config.js', () => ({
  readConfig: () => mockReadConfig(),
  writeConfig: (...args: unknown[]) => mockWriteConfig(...args),
}));

const { upgradeCommand, configCommand } = await import('../../src/commands/upgrade.js');
const { setJsonMode } = await import('../../src/lib/json-mode.js');
const { UsageError } = await import('../../src/lib/errors.js');

const available = { current: '1.5.1', latest: '1.6.0', updateAvailable: true, isMajor: false };

describe('upgrade command', () => {
  const originalExitCode = process.exitCode;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const logged = () => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  const envelope = () => JSON.parse(String(logSpy.mock.calls.at(-1)![0]));

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockCheckForUpdate.mockReset();
    mockDetectInstall.mockReset();
    mockPerformUpgrade.mockReset();
    mockReadConfig.mockReset();
    mockWriteConfig.mockReset();
    mockDetectInstall.mockResolvedValue({ kind: 'npm-global', prefix: '/usr/local' });
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    setJsonMode(false);
    vi.restoreAllMocks();
  });

  describe('upgrade', () => {
    /**
     * The regression: this read the update notice's 24-hour cache, so right
     * after a release it answered "already on the latest version" — and under
     * CI=1 it claimed the registry was unreachable.
     */
    it('always asks the registry, never the cache', async () => {
      mockCheckForUpdate.mockResolvedValue({ ...available, latest: '1.5.1', updateAvailable: false });

      await upgradeCommand.parseAsync(['node', 'test']);

      expect(mockCheckForUpdate).toHaveBeenCalledWith({ force: true });
      expect(logged()).toContain('Already on the latest version (1.5.1).');
    });

    it('reports an up-to-date CLI as JSON', async () => {
      setJsonMode(true);
      mockCheckForUpdate.mockResolvedValue({ ...available, latest: '1.5.1', updateAvailable: false });

      await upgradeCommand.parseAsync(['node', 'test']);

      expect(envelope()).toMatchObject({ success: true, data: { current: '1.5.1', latest: '1.5.1', upgraded: false }, meta: { up_to_date: true } });
    });

    it('fails when the registry cannot be reached', async () => {
      mockCheckForUpdate.mockResolvedValue(null);

      await upgradeCommand.parseAsync(['node', 'test']);

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Could not reach the npm registry'));
      expect(process.exitCode).toBe(1);
    });

    it('reports an unreachable registry as a retryable JSON failure', async () => {
      setJsonMode(true);
      mockCheckForUpdate.mockResolvedValue(null);

      await upgradeCommand.parseAsync(['node', 'test']);

      expect(envelope()).toMatchObject({ success: false, error: { code: 'upgrade.check_failed', retryable: true } });
    });

    it('installs the new version', async () => {
      mockCheckForUpdate.mockResolvedValue(available);
      mockPerformUpgrade.mockResolvedValue({ ok: true, from: '1.5.1', to: '1.6.0', message: 'Upgraded 1.5.1 → 1.6.0' });

      await upgradeCommand.parseAsync(['node', 'test']);

      expect(mockPerformUpgrade).toHaveBeenCalledWith('1.5.1', '1.6.0');
      expect(logged()).toContain('Upgraded 1.5.1 → 1.6.0');
      expect(process.exitCode).not.toBe(1);
    });

    it('warns before installing a major upgrade', async () => {
      mockCheckForUpdate.mockResolvedValue({ ...available, latest: '2.0.0', isMajor: true });
      mockPerformUpgrade.mockResolvedValue({ ok: true, from: '1.5.1', to: '2.0.0', message: 'Upgraded 1.5.1 → 2.0.0' });

      await upgradeCommand.parseAsync(['node', 'test']);

      expect(logged()).toContain('is a MAJOR upgrade and may break existing scripts');
    });

    it('reports a failed install', async () => {
      mockCheckForUpdate.mockResolvedValue(available);
      mockPerformUpgrade.mockResolvedValue({ ok: false, from: '1.5.1', to: '1.6.0', message: 'npm install failed: EACCES' });

      await upgradeCommand.parseAsync(['node', 'test']);

      expect(logged()).toContain('npm install failed: EACCES');
      expect(process.exitCode).toBe(1);
    });

    it('reports the install as JSON', async () => {
      setJsonMode(true);
      mockCheckForUpdate.mockResolvedValue(available);
      mockPerformUpgrade.mockResolvedValueOnce({ ok: true, from: '1.5.1', to: '1.6.0', message: 'ok' });

      await upgradeCommand.parseAsync(['node', 'test']);

      expect(envelope()).toMatchObject({ success: true, data: { upgraded: true, is_major: false } });

      mockPerformUpgrade.mockResolvedValueOnce({ ok: false, from: '1.5.1', to: '1.6.0', message: 'no' });
      await upgradeCommand.parseAsync(['node', 'test']);

      expect(envelope()).toMatchObject({ success: false, error: { code: 'upgrade.failed', message: 'no' } });
    });

    describe('--check', () => {
      it('says an npm-global install is ready to upgrade', async () => {
        mockCheckForUpdate.mockResolvedValue(available);

        await upgradeCommand.parseAsync(['node', 'test', '--check']);

        expect(logged()).toContain('1.5.1 → 1.6.0');
        expect(logged()).toContain('Ready to upgrade.');
        expect(mockPerformUpgrade).not.toHaveBeenCalled();
      });

      it('explains why another install cannot be upgraded, flagging a major', async () => {
        mockCheckForUpdate.mockResolvedValue({ ...available, latest: '2.0.0', isMajor: true });
        mockDetectInstall.mockResolvedValue({ kind: 'version-manager', manager: 'volta' });

        await upgradeCommand.parseAsync(['node', 'test', '--check']);

        expect(logged()).toContain('MAJOR');
        expect(logged()).toContain('refused: version-manager');
      });

      it('reports the plan as JSON', async () => {
        setJsonMode(true);
        mockCheckForUpdate.mockResolvedValue(available);
        mockDetectInstall.mockResolvedValueOnce({ kind: 'npm-global', prefix: '/usr/local' });

        await upgradeCommand.parseAsync(['node', 'test', '--check']);

        expect(envelope()).toMatchObject({ data: { can_upgrade: true, reason: null }, meta: { install_kind: 'npm-global' } });

        mockDetectInstall.mockResolvedValueOnce({ kind: 'unwritable', prefix: '/usr' });
        await upgradeCommand.parseAsync(['node', 'test', '--check']);

        expect(envelope()).toMatchObject({ data: { can_upgrade: false, reason: 'refused: unwritable' } });
      });
    });
  });

  describe('config', () => {
    it('enables auto-update', async () => {
      mockReadConfig.mockResolvedValue({ token: 't' });

      await configCommand.parseAsync(['node', 'test', 'set', 'auto-update', 'true']);

      expect(mockWriteConfig).toHaveBeenCalledWith({ token: 't', autoUpdate: true });
      expect(logged()).toContain('Major upgrades are never installed for you');
    });

    it('disables auto-update', async () => {
      mockReadConfig.mockResolvedValue({ token: 't', autoUpdate: true });

      await configCommand.parseAsync(['node', 'test', 'set', 'auto-update', 'false']);

      expect(mockWriteConfig).toHaveBeenCalledWith({ token: 't', autoUpdate: false });
      expect(logged()).toContain('disabled');
    });

    it('reports a setting change as JSON', async () => {
      setJsonMode(true);
      mockReadConfig.mockResolvedValue({ token: 't' });

      await configCommand.parseAsync(['node', 'test', 'set', 'auto-update', 'true']);

      expect(envelope()).toMatchObject({ success: true, data: { key: 'auto-update', value: true } });
    });

    it.each([
      [['set', 'colour', 'true'], /Unknown setting "colour"/],
      [['set', 'auto-update', 'yes'], /Expected "true" or "false"/],
    ])('rejects %j', async (args, message) => {
      await expect(configCommand.parseAsync(['node', 'test', ...args])).rejects.toThrow(message);
    });

    it('needs a login before it can save a setting', async () => {
      mockReadConfig.mockResolvedValue(null);

      await expect(configCommand.parseAsync(['node', 'test', 'set', 'auto-update', 'true'])).rejects.toThrow(UsageError);
    });

    it('shows the settings', async () => {
      mockReadConfig.mockResolvedValue({ token: 't', autoUpdate: true });

      await configCommand.parseAsync(['node', 'test', 'get']);

      expect(logged()).toContain('auto-update');
      expect(logged()).toContain('version      1.5.1');
    });

    it('shows the settings as JSON, defaulting auto-update off', async () => {
      setJsonMode(true);
      mockReadConfig.mockResolvedValue(null);

      await configCommand.parseAsync(['node', 'test', 'get']);

      expect(envelope().data).toEqual({ 'auto-update': false, package: '@danubedata/cli', version: '1.5.1' });
    });
  });
});
