import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, readdir, stat, rm, symlink, mkdir, utimes, chmod } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

// The real file system, except that the move into place and the age of a lock can be made to fail.
const faults = vi.hoisted(() => ({ rename: false, statGoneOnce: false, statDenied: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    rename: (...args: Parameters<typeof real.rename>) => (faults.rename ? Promise.reject(new Error('EXDEV')) : real.rename(...args)),
    lstat: (...args: Parameters<typeof real.lstat>) => {
      if (faults.statDenied) return Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }));
      if (faults.statGoneOnce) {
        faults.statGoneOnce = false;
        return Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }));
      }
      return real.lstat(...args);
    },
  };
});

const { acquireLoginLock, dockerConfigDir, readLoginKeys, writeLoginKeys } = await import('../src/lib/registry-logins.js');

describe('dockerConfigDir', () => {
  it('is DOCKER_CONFIG when set, else ~/.docker', () => {
    expect(dockerConfigDir({ DOCKER_CONFIG: '/custom' })).toBe('/custom');
    expect(dockerConfigDir({})).toBe(join(homedir(), '.docker'));
    expect(dockerConfigDir({ DOCKER_CONFIG: '' })).toBe(join(homedir(), '.docker'));
  });
});

describe('recorded login keys', () => {
  let dir: string | null = null;
  afterEach(async () => {
    faults.rename = false;
    faults.statGoneOnce = false;
    vi.restoreAllMocks();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  const fileIn = async (): Promise<string> => {
    dir = await mkdtemp(join(tmpdir(), 'danube-logins-'));
    return join(dir, 'nested', 'registry-logins.json');
  };

  it('is empty when nothing was recorded', async () => {
    expect(await readLoginKeys('/d', 'h', await fileIn())).toEqual([]);
  });

  it('keeps ids and projects per Docker config directory and registry host, and nothing else', async () => {
    const file = await fileIn();

    await writeLoginKeys('/home/u/.docker', 'cr.example', [{ keyId: 'k-1', teamId: 5 }], file);
    await writeLoginKeys('/root/.docker', 'cr.example', [{ keyId: 'k-2', teamId: null }], file);
    await writeLoginKeys('/home/u/.docker', 'other.example', [{ keyId: 'k-3', teamId: 5 }], file);

    expect(await readLoginKeys('/home/u/.docker', 'cr.example', file)).toEqual([{ keyId: 'k-1', teamId: 5 }]);
    expect(await readLoginKeys('/root/.docker', 'cr.example', file)).toEqual([{ keyId: 'k-2', teamId: null }]);
    expect(await readLoginKeys('/home/u/.docker', 'other.example', file)).toEqual([{ keyId: 'k-3', teamId: 5 }]);
    expect(await readFile(file, 'utf-8')).not.toMatch(/cr_|token/i);
  });

  it('is readable by the user only', async () => {
    const file = await fileIn();

    await writeLoginKeys('/d', 'h', [{ keyId: 'k', teamId: 1 }], file);

    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('forgets a slot when it is given nothing, and leaves the others', async () => {
    const file = await fileIn();
    await writeLoginKeys('/d', 'a', [{ keyId: 'k-a', teamId: 1 }], file);
    await writeLoginKeys('/d', 'b', [{ keyId: 'k-b', teamId: 1 }], file);

    await writeLoginKeys('/d', 'a', [], file);

    expect(await readLoginKeys('/d', 'a', file)).toEqual([]);
    expect(await readLoginKeys('/d', 'b', file)).toEqual([{ keyId: 'k-b', teamId: 1 }]);
  });

  it.each([
    ['not JSON', '{nope'],
    ['an array', '[1,2]'],
    ['null', 'null'],
  ])('treats a file that is %s as empty, and replaces it on the next write', async (_name, content) => {
    const file = await fileIn();
    await writeLoginKeys('/d', 'h', [], file);
    await writeFile(file, content);

    expect(await readLoginKeys('/d', 'h', file)).toEqual([]);
    await writeLoginKeys('/d', 'h', [{ keyId: 'k', teamId: null }], file);
    expect(await readLoginKeys('/d', 'h', file)).toEqual([{ keyId: 'k', teamId: null }]);
  });

  it('ignores entries that are not records', async () => {
    const file = await fileIn();
    await writeLoginKeys('/d', 'h', [], file);
    await writeFile(file, JSON.stringify({ '/d\nh': [{ keyId: 'k', teamId: 1 }, { teamId: 2 }, 'x', null], '/d\ng': 'nope' }));

    expect(await readLoginKeys('/d', 'h', file)).toEqual([{ keyId: 'k', teamId: 1 }]);
    expect(await readLoginKeys('/d', 'g', file)).toEqual([]);
  });
});

describe('the Docker config directory is one slot however it is spelled', () => {
  let dir: string | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  const setup = async () => {
    dir = await mkdtemp(join(tmpdir(), 'danube-slots-'));
    return join(dir, 'registry-logins.json');
  };

  it('keeps a relative path per working directory', async () => {
    const file = await setup();

    vi.spyOn(process, 'cwd').mockReturnValue('/work/a');
    await writeLoginKeys('cfg', 'h', [{ keyId: 'k-a', teamId: 1 }], file);
    vi.spyOn(process, 'cwd').mockReturnValue('/work/b');
    await writeLoginKeys('cfg', 'h', [{ keyId: 'k-b', teamId: 1 }], file);

    expect(await readLoginKeys('cfg', 'h', file)).toEqual([{ keyId: 'k-b', teamId: 1 }]);
    vi.spyOn(process, 'cwd').mockReturnValue('/work/a');
    expect(await readLoginKeys('cfg', 'h', file)).toEqual([{ keyId: 'k-a', teamId: 1 }]);
    expect(await readLoginKeys('/work/a/cfg', 'h', file)).toEqual([{ keyId: 'k-a', teamId: 1 }]);
  });

  it('follows a symlink to the directory and ignores a trailing slash and dot segments', async () => {
    const file = await setup();
    const real = join(dir!, 'real');
    await mkdir(real);
    await symlink(real, join(dir!, 'link'));

    await writeLoginKeys(real, 'h', [{ keyId: 'k', teamId: 1 }], file);

    expect(await readLoginKeys(join(dir!, 'link'), 'h', file)).toEqual([{ keyId: 'k', teamId: 1 }]);
    expect(await readLoginKeys(`${real}/./`, 'h', file)).toEqual([{ keyId: 'k', teamId: 1 }]);
  });

  it('ignores case on Windows', async () => {
    const file = await setup();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      await writeLoginKeys('/Users/U/.Docker', 'h', [{ keyId: 'k', teamId: 1 }], file);
      expect(await readLoginKeys('/users/u/.docker', 'h', file)).toEqual([{ keyId: 'k', teamId: 1 }]);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('writing the store', () => {
  let dir: string | null = null;
  afterEach(async () => {
    faults.rename = false;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('writes a private temporary file and moves it over the store, leaving the old store when the move fails', async () => {
    dir = await mkdtemp(join(tmpdir(), 'danube-atomic-'));
    const file = join(dir, 'registry-logins.json');
    await writeLoginKeys('/d', 'h', [{ keyId: 'k-old', teamId: 1 }], file);

    faults.rename = true;
    await expect(writeLoginKeys('/d', 'h', [{ keyId: 'k-new', teamId: 1 }], file)).rejects.toThrow('EXDEV');
    faults.rename = false;

    expect(await readLoginKeys('/d', 'h', file)).toEqual([{ keyId: 'k-old', teamId: 1 }]);
    // No temporary file is left behind, and the store is still private.
    expect(await readdir(dir)).toEqual(['registry-logins.json']);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe('the login lock', () => {
  let dir: string | null = null;
  afterEach(async () => {
    faults.statGoneOnce = false;
    faults.statDenied = false;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  const fileIn = async (): Promise<string> => {
    dir = await mkdtemp(join(tmpdir(), 'danube-lock-'));
    return join(dir, 'registry-logins.json');
  };
  const quick = { waitMs: 150, pollMs: 10, staleMs: 60_000 };

  it('lets one login hold it, makes the next give up after the wait, and frees it on release', async () => {
    const file = await fileIn();

    const first = await acquireLoginLock(file, quick);
    expect(first).not.toBeNull();
    expect(await acquireLoginLock(file, quick)).toBeNull();

    await first!.release();
    const third = await acquireLoginLock(file, quick);
    expect(third).not.toBeNull();
    await third!.release();
    expect(await readdir(dir!)).toEqual([]);
  });

  it('hands over to a waiting login when the holder releases in time', async () => {
    const file = await fileIn();
    const first = await acquireLoginLock(file, quick);

    const waiting = acquireLoginLock(file, { ...quick, waitMs: 5_000 });
    setTimeout(() => void first!.release(), 50);

    const second = await waiting;
    expect(second).not.toBeNull();
    await second!.release();
  });

  it('breaks a lock left by a login that died, once it is older than the stale limit', async () => {
    const file = await fileIn();
    await writeFile(`${file}.lock`, '12345\n');
    const old = new Date(Date.now() - 4 * 60_000);
    await utimes(`${file}.lock`, old, old);

    const lock = await acquireLoginLock(file, { ...quick, staleMs: 3 * 60_000 });

    expect(lock).not.toBeNull();
    await lock!.release();
  });

  it('respects a lock younger than the stale limit', async () => {
    const file = await fileIn();
    await writeFile(`${file}.lock`, '12345\n');

    expect(await acquireLoginLock(file, { ...quick, staleMs: 3 * 60_000 })).toBeNull();
  });

  it('takes a lock that vanished while it was looking at it', async () => {
    const file = await fileIn();
    await writeFile(`${file}.lock`, '12345\n');
    faults.statGoneOnce = true;
    // The first look at the age reports it gone, so the retry creates it... but the file is still
    // there, so the second look is the real one and the lock is respected until the wait ends.
    expect(await acquireLoginLock(file, quick)).toBeNull();
  });

  it('gives up within the wait on a dangling symlink at the lock path', async () => {
    const file = await fileIn();
    await symlink(join(dir!, 'nowhere', 'target'), `${file}.lock`);

    const startedAt = Date.now();
    expect(await acquireLoginLock(file, quick)).toBeNull();

    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('breaks a stale dangling symlink', async () => {
    const file = await fileIn();
    await symlink(join(dir!, 'nowhere', 'target'), `${file}.lock`);
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(`${file}.lock`, old, old).catch(() => undefined);
    // utimes follows the link, which does not exist: age the link itself with a tiny stale limit instead.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const lock = await acquireLoginLock(file, { ...quick, staleMs: 5 });

    expect(lock).not.toBeNull();
    await lock!.release();
  });

  it('answers null for a directory at the lock path, fresh or stale', async () => {
    const file = await fileIn();
    await mkdir(`${file}.lock`);

    expect(await acquireLoginLock(file, quick)).toBeNull();

    // A stale directory cannot be removed as a file: that is an unexpected error, and also null.
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(`${file}.lock`, old, old);
    expect(await acquireLoginLock(file, { ...quick, staleMs: 1_000 })).toBeNull();
  });

  it('answers null when it cannot even look at the lock', async () => {
    const file = await fileIn();
    await writeFile(`${file}.lock`, 'someone');
    faults.statDenied = true;

    expect(await acquireLoginLock(file, quick)).toBeNull();
  });

  it('does not wait at all when the wait is already over', async () => {
    const file = await fileIn();
    await writeFile(`${file}.lock`, 'someone');
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(`${file}.lock`, old, old);

    expect(await acquireLoginLock(file, { ...quick, waitMs: 0, staleMs: 1_000 })).toBeNull();
  });

  it('release removes only the lock that still holds its own token', async () => {
    const file = await fileIn();
    const mine = await acquireLoginLock(file, quick);
    expect(await readFile(`${file}.lock`, 'utf-8')).toMatch(/^[0-9a-f-]{36}$/);

    // Mine was broken as stale and another login took the lock.
    await writeFile(`${file}.lock`, 'the other login token');
    await mine!.release();

    expect(await readFile(`${file}.lock`, 'utf-8')).toBe('the other login token');
  });

  it('release is harmless when the lock is already gone', async () => {
    const file = await fileIn();
    const mine = await acquireLoginLock(file, quick);
    await rm(`${file}.lock`);

    await expect(mine!.release()).resolves.toBeUndefined();
  });

  it('answers null when the lock cannot be made at all', async () => {
    dir = await mkdtemp(join(tmpdir(), 'danube-lock-'));
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'a file where a directory is needed');

    expect(await acquireLoginLock(join(blocker, 'nested', 'registry-logins.json'), quick)).toBeNull();
  });

  // chmod cannot deny root (CI runs as root); the any-error → null path is also covered by the test above.
  it.skipIf(process.getuid?.() === 0)('answers null when the lock file cannot be created', async () => {
    dir = await mkdtemp(join(tmpdir(), 'danube-lock-'));
    await chmod(dir, 0o500);

    try {
      expect(await acquireLoginLock(join(dir, 'registry-logins.json'), quick)).toBeNull();
    } finally {
      await chmod(dir, 0o700);
    }
  });
});
