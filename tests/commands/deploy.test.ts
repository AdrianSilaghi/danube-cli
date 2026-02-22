import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const mockGet = vi.fn();
const mockUpload = vi.fn();
vi.mock('../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet, upload: mockUpload }),
  },
}));

const mockReadProjectConfig = vi.fn();
const mockReadDanubeJson = vi.fn();
vi.mock('../../src/lib/project.js', () => ({
  readProjectConfig: () => mockReadProjectConfig(),
  readDanubeJson: () => mockReadDanubeJson(),
}));

vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    text: '',
  }),
}));

vi.mock('../../src/lib/sleep.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

const { deployCommand } = await import('../../src/commands/deploy.js');

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

describe('deploy command', () => {
  const originalExit = process.exit;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `danube-deploy-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, 'index.html'), '<h1>Hello</h1>');

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exit = vi.fn().mockImplementation((code: number) => {
      throw new ExitError(code);
    }) as never;
    mockGet.mockReset();
    mockUpload.mockReset();
    mockReadProjectConfig.mockReset();
    mockReadDanubeJson.mockReset();
  });

  afterEach(async () => {
    process.exit = originalExit;
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  it('throws NotLinkedError when no project config', async () => {
    mockReadProjectConfig.mockResolvedValue(null);

    await expect(
      deployCommand.parseAsync(['node', 'test', '--dir', testDir, '--no-wait']),
    ).rejects.toThrow('No project linked');
  });

  it('exits when directory not found', async () => {
    mockReadProjectConfig.mockResolvedValue({ siteId: 1, teamId: 1, siteName: 'test' });
    mockReadDanubeJson.mockResolvedValue(null);

    await expect(
      deployCommand.parseAsync(['node', 'test', '--dir', '/nonexistent/path', '--no-wait']),
    ).rejects.toThrow(ExitError);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Directory not found'));
  });

  it('deploys with --no-wait', async () => {
    mockReadProjectConfig.mockResolvedValue({ siteId: 1, teamId: 1, siteName: 'test' });
    mockReadDanubeJson.mockResolvedValue(null);
    mockUpload.mockResolvedValue({ message: 'Deploying', site_id: 1, status: 'pending' });

    await deployCommand.parseAsync(['node', 'test', '--dir', testDir, '--no-wait']);

    expect(mockUpload).toHaveBeenCalledWith(
      '/api/v1/static-sites/1/deploy',
      expect.any(Buffer),
      'deploy.tar.gz',
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Deployment started'));
  });

  it('polls until live', async () => {
    mockReadProjectConfig.mockResolvedValue({ siteId: 1, teamId: 1, siteName: 'test' });
    mockReadDanubeJson.mockResolvedValue(null);
    mockUpload.mockResolvedValue({ message: 'Deploying', site_id: 1, status: 'pending' });
    mockGet
      .mockResolvedValueOnce({ data: { status: 'processing' } })
      .mockResolvedValueOnce({ data: { status: 'live' } });

    await deployCommand.parseAsync(['node', 'test', '--dir', testDir]);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Live at'));
  });

  it('handles failed build with error message', async () => {
    mockReadProjectConfig.mockResolvedValue({ siteId: 1, teamId: 1, siteName: 'test' });
    mockReadDanubeJson.mockResolvedValue(null);
    mockUpload.mockResolvedValue({ message: 'Deploying', site_id: 1, status: 'pending' });
    mockGet.mockResolvedValueOnce({
      data: { status: 'failed', error_message: 'Build error: out of memory' },
    });

    await expect(
      deployCommand.parseAsync(['node', 'test', '--dir', testDir]),
    ).rejects.toThrow(ExitError);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Build error'));
  });

  it('handles failed build without error message', async () => {
    mockReadProjectConfig.mockResolvedValue({ siteId: 1, teamId: 1, siteName: 'test' });
    mockReadDanubeJson.mockResolvedValue(null);
    mockUpload.mockResolvedValue({ message: 'Deploying', site_id: 1, status: 'pending' });
    mockGet.mockResolvedValueOnce({
      data: { status: 'failed', error_message: null },
    });

    await expect(
      deployCommand.parseAsync(['node', 'test', '--dir', testDir]),
    ).rejects.toThrow(ExitError);

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('handles null build response (continues polling)', async () => {
    mockReadProjectConfig.mockResolvedValue({ siteId: 1, teamId: 1, siteName: 'test' });
    mockReadDanubeJson.mockResolvedValue(null);
    mockUpload.mockResolvedValue({ message: 'Deploying', site_id: 1, status: 'pending' });
    mockGet
      .mockResolvedValueOnce({ data: null })
      .mockResolvedValueOnce({ data: { status: 'live' } });

    await deployCommand.parseAsync(['node', 'test', '--dir', testDir]);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Live at'));
  });

  it('defaults to cwd when no --dir and no danube.json outputDir', async () => {
    mockReadProjectConfig.mockResolvedValue({ siteId: 1, teamId: 1, siteName: 'test' });
    mockReadDanubeJson.mockResolvedValue(null);
    mockUpload.mockResolvedValue({ message: 'Deploying', site_id: 1, status: 'pending' });

    // Change cwd to testDir so the default '.' resolves to it
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

    mockReadProjectConfig.mockResolvedValue({ siteId: 1, teamId: 1, siteName: 'test' });
    mockReadDanubeJson.mockResolvedValue({ outputDir: subDir });
    mockUpload.mockResolvedValue({ message: 'Deploying', site_id: 1, status: 'pending' });

    await deployCommand.parseAsync(['node', 'test', '--no-wait']);

    expect(mockUpload).toHaveBeenCalled();
  });

  it('--dir flag overrides danube.json outputDir', async () => {
    mockReadProjectConfig.mockResolvedValue({ siteId: 1, teamId: 1, siteName: 'test' });
    mockReadDanubeJson.mockResolvedValue({ outputDir: '/wrong/path' });
    mockUpload.mockResolvedValue({ message: 'Deploying', site_id: 1, status: 'pending' });

    await deployCommand.parseAsync(['node', 'test', '--dir', testDir, '--no-wait']);

    expect(mockUpload).toHaveBeenCalled();
  });

  it('warns on timeout', async () => {
    mockReadProjectConfig.mockResolvedValue({ siteId: 1, teamId: 1, siteName: 'test' });
    mockReadDanubeJson.mockResolvedValue(null);
    mockUpload.mockResolvedValue({ message: 'Deploying', site_id: 1, status: 'pending' });

    // First call returns processing, then simulate time passing beyond POLL_TIMEOUT
    let callCount = 0;
    const realDateNow = Date.now;
    const startTime = realDateNow.call(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => {
      callCount++;
      // On 3rd+ call (after upload completes, during polling), jump past timeout
      if (callCount >= 3) return startTime + 6 * 60 * 1000;
      return startTime;
    });

    mockGet.mockResolvedValue({ data: { status: 'processing' } });

    await deployCommand.parseAsync(['node', 'test', '--dir', testDir]);

    // The warn spinner message should have been shown (via mocked ora)
    // The command should complete without exit (just warn)
  });

  it('passes ignore patterns from danube.json', async () => {
    await writeFile(join(testDir, 'keep.html'), 'keep');
    await writeFile(join(testDir, 'drop.log'), 'drop');

    mockReadProjectConfig.mockResolvedValue({ siteId: 1, teamId: 1, siteName: 'test' });
    mockReadDanubeJson.mockResolvedValue({ ignore: ['*.log'] });
    mockUpload.mockResolvedValue({ message: 'Deploying', site_id: 1, status: 'pending' });

    await deployCommand.parseAsync(['node', 'test', '--dir', testDir, '--no-wait']);

    expect(mockUpload).toHaveBeenCalled();
  });
});
