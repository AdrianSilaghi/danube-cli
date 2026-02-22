import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readProjectConfig, writeProjectConfig, readDanubeJson } from '../src/lib/project.js';

describe('project', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `danube-project-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    delete process.env.DANUBE_SITE_ID;
    delete process.env.DANUBE_TEAM_ID;
    delete process.env.DANUBE_SITE_NAME;
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns null when no project config exists', async () => {
    const config = await readProjectConfig(testDir);
    expect(config).toBeNull();
  });

  it('writes and reads project config', async () => {
    const cfg = { siteId: 42, teamId: 1, siteName: 'my-site' };
    await writeProjectConfig(cfg, testDir);
    const result = await readProjectConfig(testDir);
    expect(result).toEqual(cfg);
  });

  it('uses env vars when set', async () => {
    process.env.DANUBE_SITE_ID = '99';
    process.env.DANUBE_TEAM_ID = '5';
    process.env.DANUBE_SITE_NAME = 'ci-site';
    const result = await readProjectConfig(testDir);
    expect(result).toEqual({ siteId: 99, teamId: 5, siteName: 'ci-site' });
  });

  it('defaults siteName to unknown when DANUBE_SITE_NAME not set', async () => {
    process.env.DANUBE_SITE_ID = '10';
    process.env.DANUBE_TEAM_ID = '2';
    // DANUBE_SITE_NAME intentionally not set
    const result = await readProjectConfig(testDir);
    expect(result).toEqual({ siteId: 10, teamId: 2, siteName: 'unknown' });
  });

  it('returns null when no danube.json exists', async () => {
    const result = await readDanubeJson(testDir);
    expect(result).toBeNull();
  });

  it('reads danube.json', async () => {
    await writeFile(join(testDir, 'danube.json'), JSON.stringify({
      outputDir: 'dist',
      ignore: ['*.log'],
    }));
    const result = await readDanubeJson(testDir);
    expect(result).toEqual({ outputDir: 'dist', ignore: ['*.log'] });
  });
});
