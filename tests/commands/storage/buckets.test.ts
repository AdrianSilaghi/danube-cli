import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPut = vi.fn();
const mockDelete = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet, post: mockPost, put: mockPut, delete: mockDelete }),
  },
}));

vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  }),
}));

const mockInput = vi.fn();
const mockSelect = vi.fn();
const mockConfirm = vi.fn();
vi.mock('@inquirer/prompts', () => ({
  input: (...args: unknown[]) => mockInput(...args),
  select: (...args: unknown[]) => mockSelect(...args),
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

const { bucketsCommand } = await import('../../../src/commands/storage/buckets.js');

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

const makeBucket = (overrides = {}) => ({
  id: 'bucket-1',
  team_id: 1,
  name: 'my-bucket',
  region: 'fsn1',
  status: 'active',
  endpoint: 'https://s3.danubedata.ro/my-bucket',
  public_access: false,
  versioning_enabled: false,
  encryption_enabled: true,
  size_bytes: 1048576,
  object_count: 42,
  size_limit_bytes: null,
  monthly_cost_cents: 399,
  monthly_cost_dollars: '3.99',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('buckets command', () => {
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
    mockPut.mockReset();
    mockDelete.mockReset();
    mockInput.mockReset();
    mockSelect.mockReset();
    mockConfirm.mockReset();
  });

  afterEach(() => {
    process.exit = originalExit;
    vi.restoreAllMocks();
  });

  describe('ls', () => {
    it('shows message when no buckets', async () => {
      mockGet.mockResolvedValue({ data: [] });

      await bucketsCommand.parseAsync(['node', 'test', 'ls']);

      expect(consoleLogSpy).toHaveBeenCalledWith('No buckets found.');
    });

    it('displays buckets table', async () => {
      mockGet.mockResolvedValue({
        data: [makeBucket(), makeBucket({ id: 'bucket-2', name: 'other-bucket' })],
      });

      await bucketsCommand.parseAsync(['node', 'test', 'ls']);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('NAME'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('my-bucket'));
    });
  });

  describe('create', () => {
    it('creates bucket with flags', async () => {
      mockPost.mockResolvedValue({
        message: 'Created',
        bucket: makeBucket({ name: 'new-bucket' }),
      });

      await bucketsCommand.parseAsync([
        'node', 'test', 'create',
        '--name', 'new-bucket',
        '--region', 'fsn1',
        '--versioning',
        '--public',
      ]);

      expect(mockPost).toHaveBeenCalledWith('/api/v1/storage/buckets', {
        name: 'new-bucket',
        region: 'fsn1',
        versioning_enabled: true,
        public_access: true,
      });
    });

    it('creates bucket with interactive prompts', async () => {
      mockInput.mockResolvedValue('prompted-bucket');
      mockSelect.mockResolvedValue('fsn1');
      mockConfirm
        .mockResolvedValueOnce(true)   // versioning
        .mockResolvedValueOnce(false);  // public

      mockPost.mockResolvedValue({
        message: 'Created',
        bucket: makeBucket({ name: 'prompted-bucket' }),
      });

      await bucketsCommand.parseAsync(['node', 'test', 'create']);

      expect(mockInput).toHaveBeenCalled();
      expect(mockSelect).toHaveBeenCalled();
      expect(mockConfirm).toHaveBeenCalledTimes(2);
      expect(mockPost).toHaveBeenCalledWith('/api/v1/storage/buckets', {
        name: 'prompted-bucket',
        region: 'fsn1',
        versioning_enabled: true,
        public_access: false,
      });
    });
  });

  describe('get', () => {
    it('displays bucket details', async () => {
      mockGet.mockResolvedValue({ bucket: makeBucket() });

      await bucketsCommand.parseAsync(['node', 'test', 'get', 'bucket-1']);

      expect(mockGet).toHaveBeenCalledWith('/api/v1/storage/buckets/bucket-1');
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('my-bucket'));
    });
  });

  describe('update', () => {
    it('updates bucket with flags', async () => {
      mockPut.mockResolvedValue({
        message: 'Updated',
        bucket: makeBucket({ versioning_enabled: true }),
      });

      await bucketsCommand.parseAsync(['node', 'test', 'update', 'bucket-1', '--versioning']);

      expect(mockPut).toHaveBeenCalledWith('/api/v1/storage/buckets/bucket-1', {
        versioning_enabled: true,
      });
    });

    it('updates bucket with size limit', async () => {
      mockPut.mockResolvedValue({
        message: 'Updated',
        bucket: makeBucket({ size_limit_bytes: 1073741824 }),
      });

      await bucketsCommand.parseAsync(['node', 'test', 'update', 'bucket-1', '--size-limit', '1073741824']);

      expect(mockPut).toHaveBeenCalledWith('/api/v1/storage/buckets/bucket-1', {
        size_limit_bytes: 1073741824,
      });
    });

    it('exits when no flags provided', async () => {
      await expect(
        bucketsCommand.parseAsync(['node', 'test', 'update', 'bucket-1']),
      ).rejects.toThrow(ExitError);

      expect(process.exit).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('At least one option'));
    });
  });

  describe('delete', () => {
    it('deletes bucket with --force', async () => {
      mockDelete.mockResolvedValue({ message: 'Deleted' });

      await bucketsCommand.parseAsync(['node', 'test', 'delete', 'bucket-1', '--force']);

      expect(mockDelete).toHaveBeenCalledWith('/api/v1/storage/buckets/bucket-1');
    });

    it('asks for confirmation and deletes', async () => {
      mockConfirm.mockResolvedValue(true);
      mockDelete.mockResolvedValue({ message: 'Deleted' });

      await bucketsCommand.parseAsync(['node', 'test', 'delete', 'bucket-1']);

      expect(mockConfirm).toHaveBeenCalled();
      expect(mockDelete).toHaveBeenCalledWith('/api/v1/storage/buckets/bucket-1');
    });

    it('cancels when user declines', async () => {
      mockConfirm.mockResolvedValue(false);

      await bucketsCommand.parseAsync(['node', 'test', 'delete', 'bucket-1']);

      expect(consoleLogSpy).toHaveBeenCalledWith('Cancelled.');
      expect(mockDelete).not.toHaveBeenCalled();
    });
  });

  describe('metrics', () => {
    it('displays bucket metrics', async () => {
      mockGet.mockResolvedValue({
        size_bytes: 5242880,
        object_count: 100,
        monthly_cost_cents: 399,
        monthly_cost_dollars: '3.99',
        last_synced_at: '2024-06-01T12:00:00Z',
      });

      await bucketsCommand.parseAsync(['node', 'test', 'metrics', 'bucket-1']);

      expect(mockGet).toHaveBeenCalledWith('/api/v1/storage/buckets/bucket-1/metrics');
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('5.0 MB'));
    });

    it('displays metrics with no sync date', async () => {
      mockGet.mockResolvedValue({
        size_bytes: 0,
        object_count: 0,
        monthly_cost_cents: 399,
        monthly_cost_dollars: '3.99',
        last_synced_at: null,
      });

      await bucketsCommand.parseAsync(['node', 'test', 'metrics', 'bucket-1']);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('-'));
    });
  });
});
