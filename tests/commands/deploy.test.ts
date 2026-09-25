import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const mockGet = vi.fn();
const mockUpload = vi.fn();
const mockOpenLinkedSite = vi.fn();
vi.mock('../../src/lib/linked-site.js', () => ({
  openLinkedSite: () => mockOpenLinkedSite(),
}));

const mockReadDanubeJson = vi.fn();
vi.mock('../../src/lib/project.js', () => ({
  readDanubeJson: () => mockReadDanubeJson(),
}));

/** Every spinner transition, in order, e.g. "succeed:Built (build #3)". */
const spinner: string[] = [];
vi.mock('ora', () => ({
  default: (text: string) => {
    spinner.push(`start:${text}`.replace(/\x1b\[[0-9;]*m/g, ''));
    const instance = {
      text,
      start: () => instance,
      succeed: (t: string) => { spinner.push(`succeed:${t}`.replace(/\x1b\[[0-9;]*m/g, '')); return instance; },
      fail: (t: string) => { spinner.push(`fail:${t}`.replace(/\x1b\[[0-9;]*m/g, '')); return instance; },
      warn: (t: string) => { spinner.push(`warn:${t}`.replace(/\x1b\[[0-9;]*m/g, '')); return instance; },
    };
    return instance;
  },
}));

vi.mock('../../src/lib/sleep.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

const { deployCommand } = await import('../../src/commands/deploy.js');
const { setJsonMode } = await import('../../src/lib/json-mode.js');
const { NotLinkedError } = await import('../../src/lib/errors.js');

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

const SITE_ID = '01a0d8fa-35fa-709d-b9d1-319c28ba28fa';
const OLD_BUILD_ID = '01a0d8fa-835d-70e1-bcec-b6da39e05edc';
const NEW_BUILD_ID = '01a0d8fb-d25f-732f-aadb-b7ce5f1a8bfb';
const URL = 'https://site-ab12.pages.danubedata.ro';

const site = (overrides: Record<string, unknown> = {}) => ({
  id: SITE_ID, name: 'site', slug: 'site-ab12', status: 'active', last_error: null, url: URL,
  deployment_count: 2, ...overrides,
});
const build = (overrides: Record<string, unknown> = {}) => ({
  id: NEW_BUILD_ID, build_number: 3, status: 'succeeded', error_message: null, ...overrides,
});
const oldBuild = build({ id: OLD_BUILD_ID, build_number: 2 });

/**
 * Serve `builds/latest` and the site from queues, in order; each queue's last
 * entry repeats. The first `builds/latest` answer is the pre-upload baseline.
 */
function serve(builds: unknown[], sites: unknown[]): void {
  const next = (queue: unknown[]) => (queue.length > 1 ? queue.shift() : queue[0]);
  mockGet.mockImplementation(async (path: string) => ({
    data: path.endsWith('/builds/latest') ? next(builds) : next(sites),
  }));
}

describe('deploy command', () => {
  const originalExit = process.exit;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let testDir: string;

  const logged = () => consoleLogSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  const envelope = () => JSON.parse(String(consoleLogSpy.mock.calls.at(-1)![0]));

  beforeEach(async () => {
    testDir = join(tmpdir(), `danube-deploy-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, 'index.html'), '<h1>Hello</h1>');

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(`<link href="/style.css?v=${NEW_BUILD_ID}">`, { status: 200 }),
    );
    process.exit = vi.fn().mockImplementation((code: number) => {
      throw new ExitError(code);
    }) as never;
    spinner.length = 0;
    mockGet.mockReset();
    mockUpload.mockReset();
    mockReadDanubeJson.mockReset();
    mockOpenLinkedSite.mockReset();
    mockOpenLinkedSite.mockResolvedValue({
      project: { siteId: SITE_ID, teamId: 4, siteName: 'site' },
      api: { get: mockGet, upload: mockUpload },
      site: site(),
    });
    mockReadDanubeJson.mockResolvedValue(null);
    mockUpload.mockResolvedValue({ message: 'Deployment initiated.', site_id: SITE_ID, status: 'building' });
  });

  afterEach(async () => {
    process.exit = originalExit;
    setJsonMode(false);
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  it('throws NotLinkedError when nothing is linked', async () => {
    mockOpenLinkedSite.mockRejectedValue(new NotLinkedError());

    await expect(
      deployCommand.parseAsync(['node', 'test', '--dir', testDir, '--no-wait']),
    ).rejects.toThrow('No project linked');
  });

  it('exits when directory not found', async () => {
    await expect(
      deployCommand.parseAsync(['node', 'test', '--dir', '/nonexistent/path', '--no-wait']),
    ).rejects.toThrow(ExitError);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Directory not found'));
  });

  it('uploads to the site UUID with --no-wait', async () => {
    serve([oldBuild], [site()]);

    await deployCommand.parseAsync(['node', 'test', '--dir', testDir, '--no-wait']);

    expect(mockUpload).toHaveBeenCalledWith(`/api/v1/static-sites/${SITE_ID}/deploy`, expect.any(Buffer), 'deploy.zip');
    expect(logged()).toContain('Deployment started');
  });

  it('reports the upload without waiting under --json --no-wait', async () => {
    setJsonMode(true);
    serve([oldBuild], [site()]);

    await deployCommand.parseAsync(['node', 'test', '--dir', testDir, '--no-wait']);

    expect(envelope()).toMatchObject({ success: true, data: { status: 'building', site_id: SITE_ID, file_count: 1 } });
  });

  /**
   * The regression, end to end: the first poll still returns the previous,
   * succeeded build. The old loop printed "Live at" right there — before this
   * upload had been built, published or served.
   */
  it('waits for its own build, the new revision and the URL before saying Live', async () => {
    serve(
      [oldBuild, oldBuild, build({ status: 'processing' }), build()],
      [site({ status: 'building' }), site({ status: 'building' }), site({ status: 'deploying' }), site({ deployment_count: 3 })],
    );

    await deployCommand.parseAsync(['node', 'test', '--dir', testDir]);

    expect(spinner).toEqual(expect.arrayContaining([
      'succeed:Built (build #3)',
      'succeed:Published revision #3',
      'succeed:Serving the new version',
    ]));
    expect(fetchSpy).toHaveBeenCalledWith(`${URL}/`, expect.any(Object));
    expect(logged()).toContain(`Live at: ${URL}`);
  });

  it('reports revision, URL and liveness under --json', async () => {
    setJsonMode(true);
    serve([oldBuild, build()], [site({ status: 'building' }), site({ deployment_count: 3 })]);

    await deployCommand.parseAsync(['node', 'test', '--dir', testDir]);

    expect(envelope()).toEqual({
      success: true,
      data: { status: 'succeeded', build_number: 3, revision: 3, url: URL, live: true, file_count: 1 },
      error: null,
      meta: {},
    });
  });

  it('does not claim Live while the previous version is still served', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 30_000));
    fetchSpy.mockImplementation(async () => new Response(`<link href="/style.css?v=${OLD_BUILD_ID}">`, { status: 200 }));
    serve([oldBuild, build()], [site(), site({ deployment_count: 3 })]);

    await deployCommand.parseAsync(['node', 'test', '--dir', testDir]);

    expect(spinner).toContain('warn:Published, but the new version was not being served yet');
    expect(logged()).toContain(`It should be live within a minute at: ${URL}`);
    expect(logged()).not.toContain('Live at:');
  });

  it('reports live: false under --json when the new version was not seen', async () => {
    setJsonMode(true);
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 30_000));
    fetchSpy.mockImplementation(async () => new Response('default backend - 404', { status: 404 }));
    serve([oldBuild, build()], [site(), site({ deployment_count: 3 })]);

    await deployCommand.parseAsync(['node', 'test', '--dir', testDir]);

    expect(envelope().data).toMatchObject({ status: 'succeeded', live: false });
  });

  it('says so when a password prompt stops the check', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 401 }));
    serve([oldBuild, build()], [site(), site({ deployment_count: 3 })]);

    await deployCommand.parseAsync(['node', 'test', '--dir', testDir]);

    expect(spinner).toContain('succeed:Deployed (password-protected, so not checked from outside)');
    expect(logged()).toContain(`Live at: ${URL}`);
  });

  it('fails with the build error', async () => {
    serve([oldBuild, build({ status: 'failed', error_message: 'No index.html found' })], [site({ status: 'building' })]);

    await expect(deployCommand.parseAsync(['node', 'test', '--dir', testDir])).rejects.toThrow(ExitError);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(spinner).toContain('fail:Build failed');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('No index.html found'));
  });

  /** A failed deploy used to emit `success: true` with `status: failed` inside. */
  it('emits a failure envelope for a failed build under --json', async () => {
    setJsonMode(true);
    serve([oldBuild, build({ status: 'failed', error_message: 'No index.html found' })], [site({ status: 'building' })]);

    await expect(deployCommand.parseAsync(['node', 'test', '--dir', testDir])).rejects.toThrow(ExitError);

    expect(envelope()).toEqual({
      success: false,
      data: { status: 'failed', build_number: 3, file_count: 1 },
      error: { code: 'static_site.build_failed', message: 'No index.html found' },
      meta: {},
    });
  });

  it('reports a hold for review by name', async () => {
    serve([oldBuild, build({ status: 'cancelled' })], [site({ status: 'pending_review', last_error: 'On hold: duplicate content.' })]);

    await expect(deployCommand.parseAsync(['node', 'test', '--dir', testDir])).rejects.toThrow(ExitError);

    expect(spinner).toContain('fail:Deployment held for review');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('On hold: duplicate content.'));
  });

  it('fails when the revision cannot be published', async () => {
    setJsonMode(true);
    serve([oldBuild, build()], [site({ status: 'error', last_error: 'GitOps push failed' })]);

    await expect(deployCommand.parseAsync(['node', 'test', '--dir', testDir])).rejects.toThrow(ExitError);

    expect(envelope()).toMatchObject({
      success: false,
      data: { status: 'failed', build_number: 3 },
      error: { code: 'static_site.deploy_failed', message: 'GitOps push failed' },
    });
  });

  it('warns and exits 0 when the build outlasts the wait', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 60_000));
    serve([oldBuild, build({ status: 'processing' })], [site({ status: 'building' })]);

    await deployCommand.parseAsync(['node', 'test', '--dir', testDir]);

    expect(process.exit).not.toHaveBeenCalled();
    expect(spinner).toContain('warn:Timed out waiting for the build. Check status with `danube pages deployments ls`.');
  });

  it('exits 1 with a timeout envelope under --json', async () => {
    setJsonMode(true);
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 60_000));
    serve([null], [site({ status: 'building', deployment_count: 0 })]);

    await expect(deployCommand.parseAsync(['node', 'test', '--dir', testDir])).rejects.toThrow(ExitError);

    expect(envelope()).toMatchObject({
      success: false,
      data: { status: 'timeout', phase: 'build', build_number: null },
      error: { code: 'static_site.timeout', retryable: true },
    });
  });

  it('defaults to cwd when no --dir and no danube.json outputDir', async () => {
    serve([oldBuild], [site()]);

    const origCwd = process.cwd();
    process.chdir(testDir);
    try {
      await deployCommand.parseAsync(['node', 'test', '--no-wait']);
      expect(mockUpload).toHaveBeenCalled();
    } finally {
      process.chdir(origCwd);
    }
  });

  it('uses outputDir from danube.json', async () => {
    const subDir = join(testDir, 'dist');
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, 'app.js'), 'console.log("hi")');
    mockReadDanubeJson.mockResolvedValue({ outputDir: subDir });
    serve([oldBuild], [site()]);

    await deployCommand.parseAsync(['node', 'test', '--no-wait']);

    expect(spinner.some(s => s.startsWith('succeed:Packaged 1 files'))).toBe(true);
  });

  it('--dir flag overrides danube.json outputDir', async () => {
    mockReadDanubeJson.mockResolvedValue({ outputDir: '/wrong/path' });
    serve([oldBuild], [site()]);

    await deployCommand.parseAsync(['node', 'test', '--dir', testDir, '--no-wait']);

    expect(mockUpload).toHaveBeenCalled();
  });

  it('passes ignore patterns from danube.json', async () => {
    await writeFile(join(testDir, 'keep.html'), 'keep');
    await writeFile(join(testDir, 'drop.log'), 'drop');
    mockReadDanubeJson.mockResolvedValue({ ignore: ['*.log'] });
    serve([oldBuild], [site()]);

    await deployCommand.parseAsync(['node', 'test', '--dir', testDir, '--no-wait']);

    expect(spinner.some(s => s.startsWith('succeed:Packaged 2 files'))).toBe(true);
  });
});
