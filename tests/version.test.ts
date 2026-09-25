import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const testDir = join(tmpdir(), `danube-test-${randomUUID()}`);

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => testDir };
});

const {
  getCurrentVersion,
  checkForUpdate,
  printUpdateNotification,
  printAutoUpdateNotice,
  formatUpdateNotice,
  isMajorUpgrade,
  PACKAGE_NAME,
  UPDATE_CHECK_TTL_MS,
} = await import('../src/lib/version.js');

// eslint-disable-next-line no-control-regex
const plain = (lines: string[]) => lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

describe('version', () => {
  beforeEach(async () => {
    await mkdir(join(testDir, '.danube'), { recursive: true });
    delete process.env.CI;
    delete process.env.DANUBE_NO_UPDATE_CHECK;
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('getCurrentVersion', () => {
    it('returns a valid semver string', () => {
      const version = getCurrentVersion();
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('matches package.json version', async () => {
      const version = getCurrentVersion();
      const pkgRaw = await readFile(join(__dirname, '..', 'package.json'), 'utf-8');
      const pkg = JSON.parse(pkgRaw) as { version: string };
      expect(version).toBe(pkg.version);
    });
  });

  describe('PACKAGE_NAME', () => {
    it('equals @danubedata/cli', () => {
      expect(PACKAGE_NAME).toBe('@danubedata/cli');
    });
  });

  describe('checkForUpdate', () => {
    it('returns update info when registry reports newer version', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ version: '99.0.0' }), { status: 200 }),
      );

      const result = await checkForUpdate();
      expect(result).not.toBeNull();
      expect(result!.updateAvailable).toBe(true);
      expect(result!.latest).toBe('99.0.0');
      expect(result!.current).toBe(getCurrentVersion());

      fetchMock.mockRestore();
    });

    it('returns no update when versions match', async () => {
      const current = getCurrentVersion();
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ version: current }), { status: 200 }),
      );

      const result = await checkForUpdate();
      expect(result).not.toBeNull();
      expect(result!.updateAvailable).toBe(false);

      fetchMock.mockRestore();
    });

    it('returns null on network error', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

      const result = await checkForUpdate();
      expect(result).toBeNull();

      fetchMock.mockRestore();
    });

    it('returns null when fetch returns non-ok status', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Not Found', { status: 404 }),
      );

      const result = await checkForUpdate();
      expect(result).toBeNull();

      fetchMock.mockRestore();
    });

    it('uses cached result within 24h window', async () => {
      const cacheFile = join(testDir, '.danube', 'update-check.json');
      await writeFile(cacheFile, JSON.stringify({
        latest: '50.0.0',
        checkedAt: Date.now(),
      }));

      const fetchMock = vi.spyOn(globalThis, 'fetch');

      const result = await checkForUpdate();
      expect(result).not.toBeNull();
      expect(result!.latest).toBe('50.0.0');
      expect(result!.updateAvailable).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();

      fetchMock.mockRestore();
    });

    it('fetches fresh result when cache is expired', async () => {
      const cacheFile = join(testDir, '.danube', 'update-check.json');
      await writeFile(cacheFile, JSON.stringify({
        latest: '50.0.0',
        checkedAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      }));

      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ version: '60.0.0' }), { status: 200 }),
      );

      const result = await checkForUpdate();
      expect(result).not.toBeNull();
      expect(result!.latest).toBe('60.0.0');
      expect(fetchMock).toHaveBeenCalledOnce();

      fetchMock.mockRestore();
    });

    it('returns null when CI env var is set', async () => {
      process.env.CI = 'true';

      const fetchMock = vi.spyOn(globalThis, 'fetch');
      const result = await checkForUpdate();

      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();

      fetchMock.mockRestore();
    });

    it('returns null when DANUBE_NO_UPDATE_CHECK is set', async () => {
      process.env.DANUBE_NO_UPDATE_CHECK = '1';

      const fetchMock = vi.spyOn(globalThis, 'fetch');
      const result = await checkForUpdate();

      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();

      fetchMock.mockRestore();
    });

    /**
     * A day was too long: a fix published in the morning reached nobody who
     * had run the CLI the evening before.
     */
    it('trusts the cache for hours, not a day', async () => {
      const cacheFile = join(testDir, '.danube', 'update-check.json');
      await writeFile(cacheFile, JSON.stringify({ latest: '50.0.0', checkedAt: Date.now() - UPDATE_CHECK_TTL_MS - 1 }));
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ version: '60.0.0' }), { status: 200 }),
      );

      const result = await checkForUpdate();

      expect(UPDATE_CHECK_TTL_MS).toBeLessThanOrEqual(6 * 60 * 60 * 1000);
      expect(result!.latest).toBe('60.0.0');
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('never waits on the registry without a deadline', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ version: '99.0.0' }), { status: 200 }),
      );

      await checkForUpdate({ timeoutMs: 1_000 });

      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    /**
     * `danube upgrade` read the notice's cache, so for a day after a release
     * it answered "already on the latest version".
     */
    it('asks the registry despite a fresh cache when forced', async () => {
      const cacheFile = join(testDir, '.danube', 'update-check.json');
      await writeFile(cacheFile, JSON.stringify({ latest: getCurrentVersion(), checkedAt: Date.now() }));
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ version: '99.0.0' }), { status: 200 }),
      );

      const result = await checkForUpdate({ force: true });

      expect(result!.updateAvailable).toBe(true);
      expect(JSON.parse(await readFile(cacheFile, 'utf-8')).latest).toBe('99.0.0');
    });

    /** CI=1 made `danube upgrade` claim the registry was unreachable. */
    it('ignores the passive-notice opt-outs when forced', async () => {
      process.env.CI = 'true';
      process.env.DANUBE_NO_UPDATE_CHECK = '1';
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ version: '99.0.0' }), { status: 200 }),
      );

      const result = await checkForUpdate({ force: true });

      expect(result!.latest).toBe('99.0.0');
    });

    it('backs off from an unreachable registry instead of timing out on every command', async () => {
      const cacheFile = join(testDir, '.danube', 'update-check.json');
      await writeFile(cacheFile, JSON.stringify({ latest: '50.0.0', checkedAt: 0 }));
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ETIMEDOUT'));

      await expect(checkForUpdate()).resolves.toBeNull();
      const second = await checkForUpdate();

      expect(fetchMock).toHaveBeenCalledOnce();
      // The last known answer survives the failed attempt.
      expect(second!.latest).toBe('50.0.0');
    });

    it('records the attempt as "no update known" when there was no previous answer', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ENOTFOUND'));

      await checkForUpdate();

      const cache = JSON.parse(await readFile(join(testDir, '.danube', 'update-check.json'), 'utf-8'));
      expect(cache.latest).toBe(getCurrentVersion());
    });

    it('does not record a failed forced check', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('busy', { status: 503 }));

      await expect(checkForUpdate({ force: true })).resolves.toBeNull();

      await expect(readFile(join(testDir, '.danube', 'update-check.json'), 'utf-8')).rejects.toThrow();
    });

    it('returns null rather than throwing when its own version cannot be read', async () => {
      vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
        throw new SyntaxError('Unexpected end of JSON input');
      });

      await expect(checkForUpdate()).resolves.toBeNull();
    });

    it('ignores a registry answer that is not a release version', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ version: '2.0.0-beta.1' }), { status: 200 }),
      );

      await expect(checkForUpdate()).resolves.toBeNull();
    });
  });

  describe('printAutoUpdateNotice', () => {
    it('says what was installed and how to turn it off', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      printAutoUpdateNotice('1.5.1', '1.6.0');

      const output = plain(errSpy.mock.calls.map((c) => String(c[0] ?? '')));
      expect(output).toContain('Auto-updated 1.5.1 → 1.6.0');
      expect(output).toContain('danube config set auto-update false');
    });
  });

  describe('formatUpdateNotice', () => {
    it('frames the notice and tells people how to upgrade', () => {
      const lines = formatUpdateNotice('1.5.1', '1.6.0', false, 120);
      const text = plain(lines);

      expect(text).toContain('A new version of the DanubeData CLI is available: 1.5.1 → 1.6.0');
      expect(text).toContain('Run danube upgrade to get the latest features and fixes.');
      expect(text).toContain('╭');
      expect(text).toContain('╰');
      // Every framed row is the same visible width.
      const rows = plain(lines).split('\n').filter((l) => l.includes('│'));
      expect(new Set(rows.map((r) => r.length)).size).toBe(1);
    });

    it('drops the frame when the terminal is too narrow for it', () => {
      const text = plain(formatUpdateNotice('1.5.1', '1.6.0', false, 40));

      expect(text).not.toContain('╭');
      expect(text).toContain('danube upgrade');
    });

    it('frames by default when the terminal width is unknown', () => {
      expect(plain(formatUpdateNotice('1.5.1', '1.6.0', false, undefined))).toContain('╭');
    });

    it('announces a major release as breaking, with what changed', () => {
      const text = plain(formatUpdateNotice('1.6.0', '2.0.0', true, 120));

      expect(text).toContain('A MAJOR DanubeData CLI release is out: 1.6.0 → 2.0.0');
      expect(text).toContain('https://docs.danubedata.ro/failure-codes');
      expect(text).toContain('danube upgrade');
    });
  });

  describe('printUpdateNotification', () => {
    it('prints update message to console', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      printUpdateNotification('0.1.0', '1.0.0');

      const output = errSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('0.1.0');
      expect(output).toContain('1.0.0');
      // Points at the command that works under every install method. Plain
      // `npm install -g` is wrong under volta/asdf and fails on a root-owned
      // prefix, which is why `danube upgrade` exists.
      expect(output).toContain('danube upgrade');

      errSpy.mockRestore();
    });

    /**
     * The live defect this was written for: 0.18.0 → 1.0.1 renamed every
     * diagnostic finding code, and the notice described it in exactly the
     * words it uses for a patch bump.
     */
    it('marks a major upgrade as breaking and links what changed', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      printUpdateNotification('0.18.0', '1.0.1', true);

      const output = errSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('MAJOR');
      expect(output).toContain('docs.danubedata.ro/failure-codes');

      errSpy.mockRestore();
    });

    it('does not cry breaking-change on an ordinary patch', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      printUpdateNotification('1.0.1', '1.0.2', false);

      expect(errSpy.mock.calls.map(c => c[0]).join('\n')).not.toContain('MAJOR');

      errSpy.mockRestore();
    });
  });

  describe('isMajorUpgrade', () => {
    it('treats a major bump as breaking', () => {
      expect(isMajorUpgrade('0.18.0', '1.0.1')).toBe(true);
      expect(isMajorUpgrade('1.4.2', '2.0.0')).toBe(true);
    });

    it('treats same-major moves as safe', () => {
      expect(isMajorUpgrade('1.0.1', '1.0.2')).toBe(false);
      expect(isMajorUpgrade('1.0.1', '1.9.0')).toBe(false);
    });

    /**
     * Semver gives 0.x no stability promise, so a minor bump there is treated
     * as a major. Being wrong this way costs one extra prompt; being wrong the
     * other way installs a breaking change nobody asked for.
     */
    it('treats a 0.x minor bump as breaking', () => {
      expect(isMajorUpgrade('0.17.0', '0.18.0')).toBe(true);
      expect(isMajorUpgrade('0.18.0', '0.18.1')).toBe(false);
    });

    it('prints the update notification to stderr', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      printUpdateNotification('1.0.0', '1.1.0');
      expect(errSpy).toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      errSpy.mockRestore(); logSpy.mockRestore();
    });
  });
});
