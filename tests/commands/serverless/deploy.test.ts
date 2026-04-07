import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const mockGet = vi.fn();
const mockUpload = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet, upload: mockUpload }),
  },
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

vi.mock('../../../src/lib/sleep.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

const { deployCommand, POLL_TIMEOUT } = await import('../../../src/commands/serverless/deploy.js');

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

const makeContainer = (overrides = {}) => ({
  id: 'abc-123', name: 'my-api', slug: 'my-api', deployment_type: 'zip_upload',
  source_type: 'dockerfile', image: 'pending-build', image_tag: 'latest', port: 8080,
  resource_profile: 'basic', min_scale: 0, max_scale: 10, status: 'running',
  url: 'https://my-api.serverless.danubedata.ro', created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('serverless deploy command', () => {
  const originalExit = process.exit;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `danube-serverless-deploy-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, 'Dockerfile'), 'FROM node:18\nCOPY . /app');
    await writeFile(join(testDir, 'app.js'), 'console.log("hello")');

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exit = vi.fn().mockImplementation((code: number) => {
      throw new ExitError(code);
    }) as never;
    mockGet.mockReset();
    mockUpload.mockReset();
  });

  afterEach(async () => {
    process.exit = originalExit;
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  it('deploys with --no-wait', async () => {
    // Resolve container
    mockGet.mockResolvedValueOnce({
      data: [makeContainer()],
      pagination: { current_page: 1, last_page: 1, per_page: 15, total: 1 },
    });
    mockUpload.mockResolvedValue({ message: 'Deploying', container_id: 'abc-123', status: 'building' });

    await deployCommand.parseAsync(['node', 'test', 'my-api', '--dir', testDir, '--no-wait']);

    expect(mockUpload).toHaveBeenCalledWith(
      '/api/v1/serverless/abc-123/deploy',
      expect.any(Buffer),
      'deploy.zip',
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Build started'));
  });

  it('polls until succeeded', async () => {
    mockGet
      .mockResolvedValueOnce({
        data: [makeContainer()],
        pagination: { current_page: 1, last_page: 1, per_page: 15, total: 1 },
      })
      .mockResolvedValueOnce({ data: { status: 'building', build_number: 1 } })
      .mockResolvedValueOnce({ data: { status: 'succeeded', build_number: 1 } })
      .mockResolvedValueOnce({ container: makeContainer(), url: 'https://my-api.serverless.danubedata.ro', metrics: {}, monthly_cost: 0 });
    mockUpload.mockResolvedValue({ message: 'Deploying', container_id: 'abc-123', status: 'building' });

    await deployCommand.parseAsync(['node', 'test', 'my-api', '--dir', testDir]);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Live at'));
  });

  it('shows refreshed URL after successful build', async () => {
    const freshUrl = 'https://fresh-url.serverless.danubedata.ro';
    mockGet
      .mockResolvedValueOnce({
        data: [makeContainer({ url: null })],
        pagination: { current_page: 1, last_page: 1, per_page: 15, total: 1 },
      })
      .mockResolvedValueOnce({ data: { status: 'succeeded', build_number: 1 } })
      .mockResolvedValueOnce({ container: makeContainer({ url: freshUrl }), url: freshUrl, metrics: {}, monthly_cost: 0 });
    mockUpload.mockResolvedValue({ message: 'Deploying', container_id: 'abc-123', status: 'building' });

    await deployCommand.parseAsync(['node', 'test', 'my-api', '--dir', testDir]);

    expect(mockGet).toHaveBeenCalledWith('/api/v1/serverless/abc-123');
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining(freshUrl));
  });

  it('handles failed build', async () => {
    mockGet
      .mockResolvedValueOnce({
        data: [makeContainer()],
        pagination: { current_page: 1, last_page: 1, per_page: 15, total: 1 },
      })
      .mockResolvedValueOnce({ data: { status: 'failed', error_message: 'Dockerfile not found' } });
    mockUpload.mockResolvedValue({ message: 'Deploying', container_id: 'abc-123', status: 'building' });

    await expect(
      deployCommand.parseAsync(['node', 'test', 'my-api', '--dir', testDir]),
    ).rejects.toThrow(ExitError);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Dockerfile not found'));
  });

  it('exits when directory not found', async () => {
    mockGet.mockResolvedValueOnce({
      data: [makeContainer()],
      pagination: { current_page: 1, last_page: 1, per_page: 15, total: 1 },
    });

    await expect(
      deployCommand.parseAsync(['node', 'test', 'my-api', '--dir', '/nonexistent/path', '--no-wait']),
    ).rejects.toThrow(ExitError);

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('throws when container not found', async () => {
    mockGet.mockResolvedValue({ data: [], pagination: { current_page: 1, last_page: 1, per_page: 15, total: 0 } });

    await expect(
      deployCommand.parseAsync(['node', 'test', 'nonexistent', '--dir', testDir, '--no-wait']),
    ).rejects.toThrow("Container 'nonexistent' not found.");
  });

  it('exits with code 1 on timeout', async () => {
    mockGet
      .mockResolvedValueOnce({
        data: [makeContainer()],
        pagination: { current_page: 1, last_page: 1, per_page: 15, total: 1 },
      })
      .mockResolvedValue({ data: { status: 'building', build_number: 1 } });
    mockUpload.mockResolvedValue({ message: 'Deploying', container_id: 'abc-123', status: 'building' });

    // Use the mocked sleep to advance Date.now past POLL_TIMEOUT during polling.
    // We can't mock Date.now before parseAsync because archiver calls it during packaging.
    const { sleep: sleepFn } = await import('../../../src/lib/sleep.js');
    const original = Date.now;
    vi.mocked(sleepFn).mockImplementationOnce(async () => {
      // After the first sleep (first poll iteration starts), mock Date.now past timeout
      Date.now = () => original() + POLL_TIMEOUT + 1;
    });

    try {
      await expect(
        deployCommand.parseAsync(['node', 'test', 'my-api', '--dir', testDir]),
      ).rejects.toThrow(ExitError);

      expect(process.exit).toHaveBeenCalledWith(1);
    } finally {
      Date.now = original;
    }
  });
});
