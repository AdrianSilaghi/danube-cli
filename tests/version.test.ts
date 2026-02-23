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

const { getCurrentVersion, checkForUpdate, printUpdateNotification, PACKAGE_NAME } = await import('../src/lib/version.js');

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
  });

  describe('printUpdateNotification', () => {
    it('prints update message to console', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      printUpdateNotification('0.1.0', '1.0.0');

      const output = logSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('0.1.0');
      expect(output).toContain('1.0.0');
      expect(output).toContain('npm install -g @danubedata/cli');

      logSpy.mockRestore();
    });
  });
});
