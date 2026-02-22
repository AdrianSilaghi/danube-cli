import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockDelete = vi.fn();
vi.mock('../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet, post: mockPost, delete: mockDelete }),
  },
}));

const mockReadProjectConfig = vi.fn();
vi.mock('../../src/lib/project.js', () => ({
  readProjectConfig: () => mockReadProjectConfig(),
}));

vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  }),
}));

const { domainsCommand } = await import('../../src/commands/domains.js');

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

const makeDomain = (overrides = {}) => ({
  id: 1, static_site_id: 1, domain: 'example.com', type: 'custom',
  status: 'active', verification_record: null, verified_at: '2024-01-01T00:00:00Z',
  created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('domains command', () => {
  const originalExit = process.exit;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exit = vi.fn().mockImplementation((code: number) => {
      throw new ExitError(code);
    }) as never;
    mockGet.mockReset();
    mockPost.mockReset();
    mockDelete.mockReset();
    mockReadProjectConfig.mockReset();
  });

  afterEach(() => {
    process.exit = originalExit;
    vi.restoreAllMocks();
  });

  describe('ls', () => {
    it('throws NotLinkedError when no project', async () => {
      mockReadProjectConfig.mockResolvedValue(null);
      await expect(
        domainsCommand.parseAsync(['node', 'test', 'ls']),
      ).rejects.toThrow('No project linked');
    });

    it('shows message when no domains', async () => {
      mockReadProjectConfig.mockResolvedValue({ siteId: 1, teamId: 1, siteName: 'test' });
      mockGet.mockResolvedValue({ data: [] });

      await domainsCommand.parseAsync(['node', 'test', 'ls']);

      expect(consoleLogSpy).toHaveBeenCalledWith('No domains configured.');
    });

    it('displays domains table', async () => {
      mockReadProjectConfig.mockResolvedValue({ siteId: 1, teamId: 1, siteName: 'test' });
      mockGet.mockResolvedValue({
        data: [
          makeDomain(),
          makeDomain({ id: 2, domain: 'test.com', verified_at: null }),
        ],
      });

      await domainsCommand.parseAsync(['node', 'test', 'ls']);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('DOMAIN'));
    });
  });

  describe('add', () => {
    it('throws NotLinkedError when no project', async () => {
      mockReadProjectConfig.mockResolvedValue(null);
      await expect(
        domainsCommand.parseAsync(['node', 'test', 'add', 'example.com']),
      ).rejects.toThrow('No project linked');
    });

    it('adds domain and shows verification record', async () => {
      mockReadProjectConfig.mockResolvedValue({ siteId: 1, teamId: 1, siteName: 'test' });
      mockPost.mockResolvedValue({
        message: 'Added',
        data: makeDomain({
          domain: 'new.com',
          status: 'pending',
          verification_record: '_danube-verify.new.com CNAME verify.danubedata.ro',
        }),
      });

      await domainsCommand.parseAsync(['node', 'test', 'add', 'new.com']);

      expect(mockPost).toHaveBeenCalledWith('/api/v1/static-sites/1/domains', { domain: 'new.com' });
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('CNAME'));
    });

    it('adds domain without verification record', async () => {
      mockReadProjectConfig.mockResolvedValue({ siteId: 1, teamId: 1, siteName: 'test' });
      mockPost.mockResolvedValue({
        message: 'Added',
        data: makeDomain({ domain: 'new.com', verification_record: null }),
      });

      await domainsCommand.parseAsync(['node', 'test', 'add', 'new.com']);

      expect(mockPost).toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('throws NotLinkedError when no project', async () => {
      mockReadProjectConfig.mockResolvedValue(null);
      await expect(
        domainsCommand.parseAsync(['node', 'test', 'remove', 'example.com']),
      ).rejects.toThrow('No project linked');
    });

    it('exits when domain not found', async () => {
      mockReadProjectConfig.mockResolvedValue({ siteId: 1, teamId: 1, siteName: 'test' });
      mockGet.mockResolvedValue({ data: [makeDomain({ domain: 'other.com' })] });

      await expect(
        domainsCommand.parseAsync(['node', 'test', 'remove', 'notfound.com']),
      ).rejects.toThrow(ExitError);

      expect(process.exit).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
    });

    it('removes the domain', async () => {
      mockReadProjectConfig.mockResolvedValue({ siteId: 1, teamId: 1, siteName: 'test' });
      mockGet.mockResolvedValue({ data: [makeDomain({ id: 7, domain: 'bye.com' })] });
      mockDelete.mockResolvedValue({ message: 'Deleted' });

      await domainsCommand.parseAsync(['node', 'test', 'remove', 'bye.com']);

      expect(mockDelete).toHaveBeenCalledWith('/api/v1/static-sites/1/domains/7');
    });
  });

  describe('verify', () => {
    it('throws NotLinkedError when no project', async () => {
      mockReadProjectConfig.mockResolvedValue(null);
      await expect(
        domainsCommand.parseAsync(['node', 'test', 'verify', 'example.com']),
      ).rejects.toThrow('No project linked');
    });

    it('exits when domain not found', async () => {
      mockReadProjectConfig.mockResolvedValue({ siteId: 1, teamId: 1, siteName: 'test' });
      mockGet.mockResolvedValue({ data: [] });

      await expect(
        domainsCommand.parseAsync(['node', 'test', 'verify', 'missing.com']),
      ).rejects.toThrow(ExitError);

      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('verifies the domain', async () => {
      mockReadProjectConfig.mockResolvedValue({ siteId: 1, teamId: 1, siteName: 'test' });
      mockGet.mockResolvedValue({ data: [makeDomain({ id: 3, domain: 'check.com' })] });
      mockPost.mockResolvedValue({ message: 'Verification started' });

      await domainsCommand.parseAsync(['node', 'test', 'verify', 'check.com']);

      expect(mockPost).toHaveBeenCalledWith('/api/v1/static-sites/1/domains/3/verify');
    });
  });
});
