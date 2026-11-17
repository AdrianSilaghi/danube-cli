import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { dockerConfigDir, readLoginKeys, writeLoginKeys } from '../src/lib/registry-logins.js';

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
