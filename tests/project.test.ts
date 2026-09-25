import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readProjectConfig, writeProjectConfig, readDanubeJson, parseSiteId } from '../src/lib/project.js';
import { UsageError } from '../src/lib/errors.js';

const SITE_ID = '01a0d8fa-35fa-709d-b9d1-319c28ba28fa';

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
    delete process.env.DANUBE_SITE_ID;
    delete process.env.DANUBE_TEAM_ID;
    delete process.env.DANUBE_SITE_NAME;
  });

  it('returns null when no project config exists', async () => {
    const config = await readProjectConfig(testDir);
    expect(config).toBeNull();
  });

  it('writes and reads project config', async () => {
    const cfg = { siteId: SITE_ID, teamId: 1, siteName: 'my-site', siteUrl: 'https://my-site-ab12.pages.danubedata.ro' };
    await writeProjectConfig(cfg, testDir);
    const result = await readProjectConfig(testDir);
    expect(result).toEqual(cfg);
  });

  it('reads a link file without a team as unscoped', async () => {
    await mkdir(join(testDir, '.danube'), { recursive: true });
    await writeFile(join(testDir, '.danube', 'project.json'), JSON.stringify({ siteId: SITE_ID }));

    const result = await readProjectConfig(testDir);

    expect(result).toEqual({ siteId: SITE_ID, teamId: null, siteName: 'unknown' });
  });

  it('reports a link file that is not JSON instead of calling the directory unlinked', async () => {
    await mkdir(join(testDir, '.danube'), { recursive: true });
    await writeFile(join(testDir, '.danube', 'project.json'), '{ not json');

    await expect(readProjectConfig(testDir)).rejects.toThrow(/project\.json is not valid JSON/);
  });

  it('reports a link file without a siteId', async () => {
    await mkdir(join(testDir, '.danube'), { recursive: true });
    await writeFile(join(testDir, '.danube', 'project.json'), JSON.stringify({ teamId: 4 }));

    await expect(readProjectConfig(testDir)).rejects.toThrow(/has no siteId/);
  });

  describe('CI link (DANUBE_SITE_ID)', () => {
    /**
     * The regression: parseInt('01a0d8fa-…') is 1, so every CI deploy went
     * to /static-sites/1 and got a 404. Site IDs have always been UUIDs.
     */
    it('keeps the site UUID intact', async () => {
      process.env.DANUBE_SITE_ID = SITE_ID;
      process.env.DANUBE_TEAM_ID = '5';
      process.env.DANUBE_SITE_NAME = 'ci-site';

      const result = await readProjectConfig(testDir);

      expect(result).toEqual({ siteId: SITE_ID, teamId: 5, siteName: 'ci-site' });
    });

    it('accepts a UUID that starts with a letter', async () => {
      process.env.DANUBE_SITE_ID = 'A1B2C3D4-0000-7000-8000-000000000000';

      const result = await readProjectConfig(testDir);

      expect(result?.siteId).toBe('a1b2c3d4-0000-7000-8000-000000000000');
    });

    it('defaults siteName to unknown when DANUBE_SITE_NAME is not set', async () => {
      process.env.DANUBE_SITE_ID = SITE_ID;
      process.env.DANUBE_TEAM_ID = '2';

      const result = await readProjectConfig(testDir);

      expect(result).toEqual({ siteId: SITE_ID, teamId: 2, siteName: 'unknown' });
    });

    /**
     * DANUBE_SITE_ID alone used to be ignored — the CLI then looked for
     * .danube/project.json and said "No project linked", which is not what
     * was wrong. A project-locked token needs no team at all.
     */
    it('links without DANUBE_TEAM_ID, leaving the project to the usual selection', async () => {
      process.env.DANUBE_SITE_ID = SITE_ID;

      const result = await readProjectConfig(testDir);

      expect(result).toEqual({ siteId: SITE_ID, teamId: null, siteName: 'unknown' });
    });

    it('takes precedence over the link file', async () => {
      await writeProjectConfig({ siteId: '00000000-0000-7000-8000-000000000001', teamId: 1, siteName: 'file' }, testDir);
      process.env.DANUBE_SITE_ID = SITE_ID;
      process.env.DANUBE_TEAM_ID = '9';

      const result = await readProjectConfig(testDir);

      expect(result?.siteId).toBe(SITE_ID);
      expect(result?.teamId).toBe(9);
    });

    it('rejects the numeric ID the docs used to show, naming where the real one is', async () => {
      process.env.DANUBE_SITE_ID = '42';
      process.env.DANUBE_TEAM_ID = '2';

      await expect(readProjectConfig(testDir)).rejects.toThrow(UsageError);
      await expect(readProjectConfig(testDir)).rejects.toThrow(/must be a static site ID \(a UUID.*project\.json/);
    });

    it('rejects a DANUBE_TEAM_ID that is not a positive integer', async () => {
      process.env.DANUBE_SITE_ID = SITE_ID;
      process.env.DANUBE_TEAM_ID = '0';

      await expect(readProjectConfig(testDir)).rejects.toThrow(/DANUBE_TEAM_ID must be a project ID/);
    });

    it('does not treat DANUBE_TEAM_ID alone as a link', async () => {
      process.env.DANUBE_TEAM_ID = '5';

      await expect(readProjectConfig(testDir)).resolves.toBeNull();
    });
  });

  describe('parseSiteId', () => {
    it('trims and lowercases', () => {
      expect(parseSiteId(`  ${SITE_ID.toUpperCase()} `)).toBe(SITE_ID);
    });

    it.each(['', '1', '-5', 'abc', `${SITE_ID}x`, '01a0d8fa35fa709db9d1319c28ba28fa'])('rejects %j', (value) => {
      expect(() => parseSiteId(value)).toThrow(UsageError);
    });
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
