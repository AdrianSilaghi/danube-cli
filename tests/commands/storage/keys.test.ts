import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockDelete = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet, post: mockPost, delete: mockDelete }),
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
const mockConfirm = vi.fn();
vi.mock('@inquirer/prompts', () => ({
  input: (...args: unknown[]) => mockInput(...args),
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

const { keysCommand } = await import('../../../src/commands/storage/keys.js');
const { setJsonMode } = await import('../../../src/lib/json-mode.js');
const { UsageError, ResourceNotFoundError } = await import('../../../src/lib/errors.js');

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

const makeKey = (overrides = {}) => ({
  id: 'key-1',
  team_id: 1,
  name: 'my-key',
  access_key_id: 'AKIAEXAMPLE123',
  status: 'active',
  expires_at: null,
  last_used_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

const makeBucket = (name: string, overrides = {}) => ({
  id: `b-${name}`,
  team_id: 1,
  name,
  status: 'active',
  ...overrides,
});

const page = (items: unknown[]) => ({
  data: items,
  pagination: { current_page: 1, last_page: 1, per_page: 100, total: items.length },
});

const SECRET = 'SECRET-SHOWN-ONCE-0123456789';

/** What the API answers to a create: the key, its secret, and where it reaches. */
const created = (overrides = {}) => ({
  id: 'key-uuid-1',
  name: 'svc',
  access_key_id: 'DDAKCREATED0000001',
  secret_access_key: SECRET,
  arn: null,
  scope: 'team',
  bucket_permissions: [],
  expires_at: null,
  message: 'Access key created. Make sure to save the secret key - it will not be shown again.',
  ...overrides,
});

const ARN = 'arn:aws:iam:::user/team-4-sk-k3j9x2mq';

// eslint-disable-next-line no-control-regex
const plain = (text: string): string => text.replace(/\x1B\[[0-9;]*m/g, '');

describe('keys command', () => {
  const originalExit = process.exit;
  const originalIsTTY = process.stdin.isTTY;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  /** Everything the command wrote, to either stream, without colour. */
  const printed = (): string =>
    [...consoleLogSpy.mock.calls, ...consoleErrorSpy.mock.calls].map((c) => plain(String(c[0] ?? ''))).join('\n');

  /** The body that actually goes over the wire for the first POST. */
  const sentBody = (): Record<string, unknown> => JSON.parse(JSON.stringify(mockPost.mock.calls[0]![1]));

  const routeBuckets = (...buckets: ReturnType<typeof makeBucket>[]) => {
    mockGet.mockImplementation((path: string) =>
      path.startsWith('/api/v1/storage/buckets?')
        ? Promise.resolve(page(buckets))
        : Promise.reject(new Error(`unexpected GET ${path}`)),
    );
  };

  const jsonOutputOf = (): { success: boolean; data: any; error: any } =>
    JSON.parse(String(consoleLogSpy.mock.calls.at(-1)![0]));

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exit = vi.fn().mockImplementation((code: number) => {
      throw new ExitError(code);
    }) as never;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mockGet.mockReset();
    mockPost.mockReset();
    mockDelete.mockReset();
    mockInput.mockReset();
    mockConfirm.mockReset();
  });

  afterEach(() => {
    process.exit = originalExit;
    process.exitCode = undefined;
    setJsonMode(false);
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    vi.restoreAllMocks();
  });

  describe('ls', () => {
    it('shows message when no keys', async () => {
      mockGet.mockResolvedValue({ data: [] });

      await keysCommand.parseAsync(['node', 'test', 'ls']);

      expect(consoleLogSpy).toHaveBeenCalledWith('No access keys found.');
    });

    it('displays keys table', async () => {
      mockGet.mockResolvedValue({
        data: [
          makeKey(),
          makeKey({ id: 'key-2', name: 'other-key', access_key_id: 'AKIAOTHER456' }),
        ],
      });

      await keysCommand.parseAsync(['node', 'test', 'ls']);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('NAME'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('AKIAEXAMPLE123'));
    });

    it('shows the id that get and revoke take, and the scope, as columns', async () => {
      mockGet.mockResolvedValue(page([
        makeKey({ id: '3f0c6a52-0e4b-4a3a-9d56-7c1d2b1a0001', name: 'team-key', scope: 'team', arn: null }),
        makeKey({ id: '3f0c6a52-0e4b-4a3a-9d56-7c1d2b1a0002', name: 'folder-key', scope: 'none', arn: ARN }),
        makeKey({ id: '3f0c6a52-0e4b-4a3a-9d56-7c1d2b1a0003', name: 'chosen-key', scope: 'buckets', arn: ARN }),
      ]));

      await keysCommand.parseAsync(['node', 'test', 'ls']);

      const [header, , ...rows] = plain(String(consoleLogSpy.mock.calls[0]![0])).split('\n');
      expect(header!.split(/\s{2,}/).slice(0, 4)).toEqual(['ID', 'NAME', 'ACCESS KEY', 'SCOPE']);
      expect(rows).toHaveLength(3);
      expect(rows[0]).toContain('3f0c6a52-0e4b-4a3a-9d56-7c1d2b1a0001');
      expect(rows[0]).toMatch(/team-key\s+AKIAEXAMPLE123\s+team\s/);
      expect(rows[1]).toMatch(/folder-key\s+AKIAEXAMPLE123\s+none\s/);
      expect(rows[2]).toMatch(/chosen-key\s+AKIAEXAMPLE123\s+buckets\s/);
    });

    it('shows a dash for the scope of a key from a server that does not report one', async () => {
      mockGet.mockResolvedValue(page([makeKey()]));

      await keysCommand.parseAsync(['node', 'test', 'ls']);

      expect(plain(String(consoleLogSpy.mock.calls[0]![0]))).toMatch(/AKIAEXAMPLE123\s+-\s+active/);
    });

    it('keeps the ARN out of the table: get shows it', async () => {
      mockGet.mockResolvedValue(page([makeKey({ scope: 'none', arn: ARN })]));

      await keysCommand.parseAsync(['node', 'test', 'ls']);

      expect(printed()).not.toContain(ARN);
    });

    it('shows when a key expires and when it was last used', async () => {
      mockGet.mockResolvedValue(page([
        makeKey({ scope: 'team', expires_at: '2027-01-01T00:00:00Z', last_used_at: '2026-10-01T12:00:00Z' }),
      ]));

      await keysCommand.parseAsync(['node', 'test', 'ls']);

      const [, , row] = plain(String(consoleLogSpy.mock.calls[0]![0])).split('\n');
      expect(row).not.toContain('never');
      expect(row).not.toMatch(/\s-\s/);
    });

    it('says when the list is cut short', async () => {
      mockGet.mockResolvedValue({
        data: [makeKey()],
        pagination: { current_page: 1, last_page: 1, per_page: 100, total: 150 },
      });

      await keysCommand.parseAsync(['node', 'test', 'ls']);

      expect(printed()).toContain('Showing 1 of 150.');
    });

    it('prints the keys as the API returned them under --json', async () => {
      const items = [makeKey({ scope: 'none', arn: ARN, bucket_permissions: [], something_new: { nested: true } })];
      mockGet.mockResolvedValue(page(items));
      setJsonMode(true);

      await keysCommand.parseAsync(['node', 'test', 'ls']);

      expect(jsonOutputOf().data).toEqual(items);
    });
  });

  describe('create', () => {
    it('creates key with --name flag', async () => {
      mockPost.mockResolvedValue({
        message: 'Created',
        ...makeKey({ name: 'cli-key' }),
        secret_access_key: 'SECRET123456',
      });

      await keysCommand.parseAsync(['node', 'test', 'create', '--name', 'cli-key']);

      expect(mockPost).toHaveBeenCalledWith('/api/v1/storage/access-keys', { name: 'cli-key' });
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('SECRET123456'));
    });

    it('creates key with expiration', async () => {
      mockPost.mockResolvedValue({
        message: 'Created',
        ...makeKey({ name: 'temp-key', expires_at: '2025-12-31T00:00:00Z' }),
        secret_access_key: 'TEMPSECRET',
      });

      await keysCommand.parseAsync([
        'node', 'test', 'create',
        '--name', 'temp-key',
        '--expires', '2025-12-31T00:00:00Z',
      ]);

      expect(mockPost).toHaveBeenCalledWith('/api/v1/storage/access-keys', {
        name: 'temp-key',
        expires_at: '2025-12-31T00:00:00Z',
      });
    });

    it('prompts for name when not provided', async () => {
      mockInput.mockResolvedValue('prompted-key');
      mockPost.mockResolvedValue({
        message: 'Created',
        ...makeKey({ name: 'prompted-key' }),
        secret_access_key: 'SECRETPROMPTED',
      });

      await keysCommand.parseAsync(['node', 'test', 'create']);

      expect(mockInput).toHaveBeenCalled();
      expect(mockPost).toHaveBeenCalledWith('/api/v1/storage/access-keys', { name: 'prompted-key' });
    });

    it('only accepts a name that is not blank when it asks for one', async () => {
      mockInput.mockResolvedValue('prompted-key');
      mockPost.mockResolvedValue(created());

      await keysCommand.parseAsync(['node', 'test', 'create']);

      const { validate } = mockInput.mock.calls[0]![0];
      expect(validate('')).toBe('Name is required');
      expect(validate('   ')).toBe('Name is required');
      expect(validate('svc')).toBe(true);
    });

    describe('what is asked of the API', () => {
      it('sends only the name for an old-style create: no scope, no bucket_permissions, no bucket lookup', async () => {
        mockPost.mockResolvedValue(created());

        await keysCommand.parseAsync(['node', 'test', 'create', '--name', 'svc']);

        // Compared as the JSON that goes over the wire: a `scope: undefined`
        // left in the object would pass a looser comparison.
        expect(JSON.stringify(mockPost.mock.calls[0]![1])).toBe('{"name":"svc"}');
        expect(mockPost.mock.calls[0]![0]).toBe('/api/v1/storage/access-keys');
        expect(mockGet).not.toHaveBeenCalled();
      });

      it('sends only the name and the expiry for an old-style create with --expires', async () => {
        mockPost.mockResolvedValue(created());

        await keysCommand.parseAsync(['node', 'test', 'create', '--name', 'svc', '--expires', '2027-01-01T00:00:00Z']);

        expect(sentBody()).toStrictEqual({ name: 'svc', expires_at: '2027-01-01T00:00:00Z' });
      });

      it('sends scope team, and nothing about buckets, for --scope team', async () => {
        mockPost.mockResolvedValue(created());

        await keysCommand.parseAsync(['node', 'test', 'create', '--name', 'svc', '--scope', 'team']);

        expect(sentBody()).toStrictEqual({ name: 'svc', scope: 'team' });
        expect(mockGet).not.toHaveBeenCalled();
      });

      it('sends scope none, and no bucket_permissions at all, for --scope none', async () => {
        mockPost.mockResolvedValue(created({ arn: ARN, scope: 'none' }));

        await keysCommand.parseAsync(['node', 'test', 'create', '--name', 'svc', '--scope', 'none']);

        expect(sentBody()).toStrictEqual({ name: 'svc', scope: 'none' });
        expect(mockGet).not.toHaveBeenCalled();
      });

      it('resolves each --bucket by name to its id and sends the levels, in the order given', async () => {
        routeBuckets(makeBucket('invoices'), makeBucket('logs'), makeBucket('media'));
        mockPost.mockResolvedValue(created({
          arn: ARN,
          scope: 'buckets',
          bucket_permissions: [{ bucket_id: 'b-media', level: 'full' }, { bucket_id: 'b-invoices', level: 'read' }],
        }));

        await keysCommand.parseAsync([
          'node', 'test', 'create', '--name', 'svc',
          '--scope', 'buckets', '--bucket', 'media:full', '--bucket', 'invoices:read',
        ]);

        expect(sentBody()).toStrictEqual({
          name: 'svc',
          scope: 'buckets',
          bucket_permissions: [
            { bucket_id: 'b-media', level: 'full' },
            { bucket_id: 'b-invoices', level: 'read' },
          ],
        });
      });

      it('takes a bucket by id as well as by name', async () => {
        routeBuckets(makeBucket('invoices'), makeBucket('logs'));
        mockPost.mockResolvedValue(created({ arn: ARN, scope: 'buckets', bucket_permissions: [{ bucket_id: 'b-logs', level: 'readwrite' }] }));

        await keysCommand.parseAsync(['node', 'test', 'create', '--name', 'svc', '--scope', 'buckets', '--bucket', 'b-logs:readwrite']);

        expect(sentBody().bucket_permissions).toStrictEqual([{ bucket_id: 'b-logs', level: 'readwrite' }]);
      });

      it('lists the buckets once, however many are named', async () => {
        routeBuckets(makeBucket('a'), makeBucket('b'), makeBucket('c'));
        mockPost.mockResolvedValue(created({ arn: ARN, scope: 'buckets' }));

        await keysCommand.parseAsync([
          'node', 'test', 'create', '--name', 'svc', '--scope', 'buckets',
          '--bucket', 'a:read', '--bucket', 'b:read', '--bucket', 'c:read',
        ]);

        expect(mockGet).toHaveBeenCalledTimes(1);
      });

      it('accepts fifty buckets', async () => {
        const fifty = Array.from({ length: 50 }, (_, i) => makeBucket(`bucket-${i}`));
        routeBuckets(...fifty);
        mockPost.mockResolvedValue(created({ arn: ARN, scope: 'buckets' }));

        await keysCommand.parseAsync([
          'node', 'test', 'create', '--name', 'svc', '--scope', 'buckets',
          ...fifty.flatMap((b) => ['--bucket', `${b.name}:read`]),
        ]);

        expect(sentBody().bucket_permissions).toHaveLength(50);
      });

      it('does not create a key when a bucket cannot be found', async () => {
        routeBuckets(makeBucket('invoices'));

        await expect(keysCommand.parseAsync([
          'node', 'test', 'create', '--name', 'svc', '--scope', 'buckets',
          '--bucket', 'invoices:read', '--bucket', 'nope:read',
        ])).rejects.toThrow(ResourceNotFoundError);

        expect(mockPost).not.toHaveBeenCalled();
      });

      it.each([
        ['twice by name', ['invoices:read', 'invoices:full']],
        ['once by name and once by id', ['invoices:read', 'b-invoices:full']],
      ])('does not create a key when the same bucket is named %s', async (_how, specs) => {
        routeBuckets(makeBucket('invoices'), makeBucket('logs'));

        const attempt = keysCommand.parseAsync([
          'node', 'test', 'create', '--name', 'svc', '--scope', 'buckets',
          ...specs.flatMap((s) => ['--bucket', s]),
        ]);

        await expect(attempt).rejects.toThrow(UsageError);
        await expect(attempt).rejects.toThrow(/'invoices'.*twice/);
        expect(mockPost).not.toHaveBeenCalled();
      });
    });

    describe('refusals made before anything is sent', () => {
      const refused: Array<[string, string[], RegExp]> = [
        ['--bucket without a scope', ['--bucket', 'invoices:read'], /--bucket needs --scope buckets/],
        ['--scope buckets without a bucket', ['--scope', 'buckets'], /--scope buckets needs at least one --bucket/],
        ['--scope team with a bucket', ['--scope', 'team', '--bucket', 'invoices:read'], /--scope team takes no --bucket/],
        ['--scope none with a bucket', ['--scope', 'none', '--bucket', 'invoices:read'], /--scope none takes no --bucket/],
        ['a scope that does not exist', ['--scope', 'everything'], /team, buckets or none/],
        ['a bucket with no level', ['--scope', 'buckets', '--bucket', 'invoices'], /<bucket>:<level>/],
        ['a level that does not exist', ['--scope', 'buckets', '--bucket', 'invoices:admin'], /read, readwrite or full/],
        ['a level with no bucket', ['--scope', 'buckets', '--bucket', ':read'], /names no bucket/],
        [
          'fifty-one buckets',
          ['--scope', 'buckets', ...Array.from({ length: 51 }, (_, i) => ['--bucket', `b${i}:read`]).flat()],
          /at most 50/,
        ],
      ];

      it.each(refused)('refuses %s as a usage error and makes no request', async (_name, flags, message) => {
        const attempt = keysCommand.parseAsync(['node', 'test', 'create', '--name', 'svc', ...flags]);

        await expect(attempt).rejects.toThrow(UsageError);
        await expect(attempt).rejects.toThrow(message);
        expect(mockGet).not.toHaveBeenCalled();
        expect(mockPost).not.toHaveBeenCalled();
      });

      it('checks the flags before it asks for a name', async () => {
        await expect(keysCommand.parseAsync(['node', 'test', 'create', '--scope', 'everything'])).rejects.toThrow(UsageError);

        expect(mockInput).not.toHaveBeenCalled();
      });
    });

    describe('a key that did not get the scope that was asked for', () => {
      // An older server ignores a field it does not know and answers with the
      // key it did create: a team key, which reaches every bucket. Printing
      // that as a success would hand over a key broader than the one asked for.
      it('is not reported as a success when --scope none comes back as team', async () => {
        mockPost.mockResolvedValue(created({ scope: 'team', arn: null }));

        await expect(keysCommand.parseAsync(['node', 'test', 'create', '--name', 'svc', '--scope', 'none']))
          .rejects.toThrow(ExitError);

        expect(process.exit).toHaveBeenCalledWith(1);
        const output = printed();
        expect(output).toContain('did not apply the scope you asked for');
        expect(output).toContain('asked for: none');
        expect(output).toContain('reported: team');
        expect(output).toContain('danube storage keys revoke key-uuid-1');
      });

      it('does not print the secret of a key that is not what was asked for', async () => {
        mockPost.mockResolvedValue(created({ scope: 'team', arn: null }));

        await expect(keysCommand.parseAsync(['node', 'test', 'create', '--name', 'svc', '--scope', 'none'])).rejects.toThrow(ExitError);

        expect(printed()).not.toContain(SECRET);
        expect(printed()).not.toContain('Secret Access Key');
      });

      it('is not reported as a success when the answer does not say what scope the key has', async () => {
        routeBuckets(makeBucket('invoices'));
        const { scope: _omitted, ...withoutScope } = created({ arn: ARN });
        mockPost.mockResolvedValue(withoutScope);

        await expect(keysCommand.parseAsync([
          'node', 'test', 'create', '--name', 'svc', '--scope', 'buckets', '--bucket', 'invoices:read',
        ])).rejects.toThrow(ExitError);

        expect(printed()).toContain('reported: no scope');
        expect(printed()).not.toContain(SECRET);
      });

      it('says so as one failure envelope under --json, with the key id and without the secret', async () => {
        mockPost.mockResolvedValue(created({ scope: 'team', arn: null }));
        setJsonMode(true);

        await expect(keysCommand.parseAsync(['node', 'test', 'create', '--name', 'svc', '--scope', 'none']))
          .rejects.toThrow(ExitError);

        expect(process.exit).toHaveBeenCalledWith(1);
        const out = jsonOutputOf();
        expect(out.success).toBe(false);
        expect(out.error).toMatchObject({
          code: 'storage.key_scope_not_applied',
          id: 'key-uuid-1',
          requested_scope: 'none',
          reported_scope: 'team',
        });
        expect(JSON.stringify(out)).not.toContain(SECRET);
      });

      it('does not second-guess an answer that matches what was asked', async () => {
        mockPost.mockResolvedValue(created({ scope: 'none', arn: ARN }));

        await keysCommand.parseAsync(['node', 'test', 'create', '--name', 'svc', '--scope', 'none']);

        expect(process.exit).not.toHaveBeenCalled();
        expect(printed()).toContain(SECRET);
      });

      it('does not check a team key, which cannot be broader than what a team key is', async () => {
        const { scope: _omitted, ...withoutScope } = created();
        mockPost.mockResolvedValue(withoutScope);

        await keysCommand.parseAsync(['node', 'test', 'create', '--name', 'svc', '--scope', 'team']);

        expect(printed()).toContain(SECRET);
      });

      it('does not check an old-style create, where no scope was asked for', async () => {
        const { scope: _omitted, ...withoutScope } = created();
        mockPost.mockResolvedValue(withoutScope);

        await keysCommand.parseAsync(['node', 'test', 'create', '--name', 'svc']);

        expect(printed()).toContain(SECRET);
      });
    });

    describe('what it says about the new key', () => {
      it('shows the id, the secret once, the scope and that a team key signs as the team', async () => {
        mockPost.mockResolvedValue(created({ scope: 'team', arn: null }));

        await keysCommand.parseAsync(['node', 'test', 'create', '--name', 'svc']);

        const output = printed();
        expect(output).toMatch(/Access Key ID:\s+DDAKCREATED0000001/);
        expect(output).toMatch(new RegExp(`Secret Access Key:\\s+${SECRET}`));
        expect(output).toMatch(/Scope:\s+team/);
        expect(output).toMatch(/ARN:\s+none: signs as the team/);
        expect(output).toContain('will not be shown again');
      });

      it('says a none key reaches nothing until a policy allows it, with its ARN and the command to run next', async () => {
        mockPost.mockResolvedValue(created({ scope: 'none', arn: ARN }));

        await keysCommand.parseAsync(['node', 'test', 'create', '--name', 'svc', '--scope', 'none']);

        const output = printed();
        expect(output).toMatch(/Scope:\s+none/);
        expect(output).toMatch(new RegExp(`ARN:\\s+${ARN}`));
        expect(output).toContain('reaches nothing until a bucket policy allows it');
        expect(output).toContain('danube storage policy grant <bucket> --key key-uuid-1 --folder <folder> --level');
        expect(output).toContain('danube storage policy grant <bucket> --key key-uuid-1 --whole-bucket --level');
        expect(output).toMatch(new RegExp(`Secret Access Key:\\s+${SECRET}`));
      });

      it('does not tell a team key or a buckets key to wait for a policy', async () => {
        routeBuckets(makeBucket('invoices'));
        mockPost.mockResolvedValue(created({ scope: 'buckets', arn: ARN, bucket_permissions: [{ bucket_id: 'b-invoices', level: 'read' }] }));

        await keysCommand.parseAsync(['node', 'test', 'create', '--name', 'svc', '--scope', 'buckets', '--bucket', 'invoices:read']);

        expect(printed()).not.toContain('reaches nothing');
        expect(printed()).not.toContain('policy grant');
      });

      it('lists the buckets of a buckets key with their levels, by name', async () => {
        routeBuckets(makeBucket('invoices'), makeBucket('logs'));
        mockPost.mockResolvedValue(created({
          scope: 'buckets',
          arn: ARN,
          bucket_permissions: [{ bucket_id: 'b-invoices', level: 'read' }, { bucket_id: 'b-logs', level: 'full' }],
        }));

        await keysCommand.parseAsync([
          'node', 'test', 'create', '--name', 'svc', '--scope', 'buckets', '--bucket', 'invoices:read', '--bucket', 'logs:full',
        ]);

        const output = printed();
        expect(output).toMatch(/Scope:\s+buckets/);
        expect(output).toMatch(/Buckets:\s+invoices \(read\)/);
        expect(output).toMatch(/logs \(full\)/);
        expect(output).toMatch(new RegExp(`ARN:\\s+${ARN}`));
      });

      it('falls back to the bucket id when the answer names a bucket that was not asked for by name', async () => {
        routeBuckets(makeBucket('invoices'));
        mockPost.mockResolvedValue(created({ scope: 'buckets', arn: ARN, bucket_permissions: [{ bucket_id: 'b-elsewhere', level: 'read' }] }));

        await keysCommand.parseAsync(['node', 'test', 'create', '--name', 'svc', '--scope', 'buckets', '--bucket', 'invoices:read']);

        expect(printed()).toMatch(/Buckets:\s+b-elsewhere \(read\)/);
      });

      it('says nothing about scope or ARN when the server does not report them', async () => {
        mockPost.mockResolvedValue({ id: 'k', name: 'svc', access_key_id: 'AK', secret_access_key: SECRET, expires_at: null, message: 'ok' });

        await keysCommand.parseAsync(['node', 'test', 'create', '--name', 'svc']);

        expect(printed()).not.toContain('Scope:');
        expect(printed()).not.toContain('ARN:');
        expect(printed()).toContain(SECRET);
      });

      it('prints the arn, scope and buckets as JSON next to what it always printed', async () => {
        routeBuckets(makeBucket('invoices'));
        mockPost.mockResolvedValue(created({
          scope: 'buckets',
          arn: ARN,
          expires_at: '2027-01-01T00:00:00Z',
          bucket_permissions: [{ bucket_id: 'b-invoices', level: 'read' }],
        }));
        setJsonMode(true);

        await keysCommand.parseAsync(['node', 'test', 'create', '--name', 'svc', '--scope', 'buckets', '--bucket', 'invoices:read']);

        const out = jsonOutputOf();
        expect(out.success).toBe(true);
        expect(out.data).toStrictEqual({
          id: 'key-uuid-1',
          name: 'svc',
          access_key_id: 'DDAKCREATED0000001',
          secret_access_key: SECRET,
          expires_at: '2027-01-01T00:00:00Z',
          arn: ARN,
          scope: 'buckets',
          bucket_permissions: [{ bucket_id: 'b-invoices', level: 'read' }],
        });
      });

      it('prints a null arn for a key that signs as the team', async () => {
        mockPost.mockResolvedValue(created());
        setJsonMode(true);

        await keysCommand.parseAsync(['node', 'test', 'create', '--name', 'svc']);

        expect(jsonOutputOf().data).toMatchObject({ arn: null, scope: 'team', bucket_permissions: [] });
      });
    });
  });

  describe('get', () => {
    it('displays key details', async () => {
      mockGet.mockResolvedValue({ access_key: makeKey() });

      await keysCommand.parseAsync(['node', 'test', 'get', 'key-1']);

      expect(mockGet).toHaveBeenCalledWith('/api/v1/storage/access-keys/key-1');
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('my-key'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('AKIAEXAMPLE123'));
    });

    it('shows when the key expires and when it was last used', async () => {
      mockGet.mockResolvedValue({
        access_key: makeKey({ expires_at: '2027-01-01T00:00:00Z', last_used_at: '2026-10-01T12:00:00Z' }),
      });

      await keysCommand.parseAsync(['node', 'test', 'get', 'key-1']);

      expect(printed()).not.toMatch(/Expires\s+never/);
      expect(printed()).not.toMatch(/Last Used\s+-/);
    });

    it('says a team key signs as the team', async () => {
      mockGet.mockResolvedValue({ access_key: makeKey({ scope: 'team', arn: null, bucket_permissions: [] }) });

      await keysCommand.parseAsync(['node', 'test', 'get', 'key-1']);

      expect(printed()).toMatch(/Scope\s+team/);
      expect(printed()).toMatch(/ARN\s+signs as the team/);
    });

    it('shows the ARN of a key with an identity of its own', async () => {
      mockGet.mockResolvedValue({ access_key: makeKey({ scope: 'none', arn: ARN, bucket_permissions: [] }) });

      await keysCommand.parseAsync(['node', 'test', 'get', 'key-1']);

      expect(printed()).toMatch(/Scope\s+none/);
      expect(printed()).toMatch(new RegExp(`ARN\\s+${ARN}`));
      expect(printed()).toContain('reaches only what a bucket policy allows');
    });

    it('lists the buckets of a buckets key with their names and levels', async () => {
      mockGet.mockResolvedValue({
        access_key: makeKey({
          scope: 'buckets',
          arn: ARN,
          bucket_permissions: [
            { bucket_id: 'b-invoices', bucket_name: 'invoices', level: 'read' },
            { bucket_id: 'b-logs', bucket_name: 'logs', level: 'full' },
          ],
        }),
      });

      await keysCommand.parseAsync(['node', 'test', 'get', 'key-1']);

      expect(printed()).toMatch(/Scope\s+buckets/);
      expect(printed()).toMatch(/Buckets\s+invoices \(read\)/);
      expect(printed()).toMatch(/logs \(full\)/);
    });

    it('shows the id of a bucket the API could not name', async () => {
      mockGet.mockResolvedValue({
        access_key: makeKey({
          scope: 'buckets',
          arn: ARN,
          bucket_permissions: [{ bucket_id: 'b-gone', bucket_name: null, level: 'readwrite' }],
        }),
      });

      await keysCommand.parseAsync(['node', 'test', 'get', 'key-1']);

      expect(printed()).toMatch(/Buckets\s+b-gone \(readwrite\)/);
    });

    it('does not break on a server that reports none of it', async () => {
      mockGet.mockResolvedValue({ access_key: makeKey() });

      await keysCommand.parseAsync(['node', 'test', 'get', 'key-1']);

      expect(printed()).not.toContain('Scope');
      expect(printed()).not.toContain('ARN');
    });

    it('prints the key as the API returned it under --json', async () => {
      const access_key = makeKey({ scope: 'none', arn: ARN, bucket_permissions: [], something_new: 1 });
      mockGet.mockResolvedValue({ access_key });
      setJsonMode(true);

      await keysCommand.parseAsync(['node', 'test', 'get', 'key-1']);

      expect(jsonOutputOf().data).toEqual(access_key);
    });
  });

  describe('revoke', () => {
    it('revokes key with --force', async () => {
      mockDelete.mockResolvedValue({ message: 'Revoked' });

      await keysCommand.parseAsync(['node', 'test', 'revoke', 'key-1', '--force']);

      expect(mockDelete).toHaveBeenCalledWith('/api/v1/storage/access-keys/key-1');
    });

    it('asks for confirmation and revokes', async () => {
      mockConfirm.mockResolvedValue(true);
      mockDelete.mockResolvedValue({ message: 'Revoked' });

      await keysCommand.parseAsync(['node', 'test', 'revoke', 'key-1']);

      expect(mockConfirm).toHaveBeenCalled();
      expect(mockDelete).toHaveBeenCalledWith('/api/v1/storage/access-keys/key-1');
    });

    it('cancels when user declines', async () => {
      mockConfirm.mockResolvedValue(false);

      await keysCommand.parseAsync(['node', 'test', 'revoke', 'key-1']);

      expect(consoleLogSpy).toHaveBeenCalledWith('Cancelled.');
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('says which key was revoked under --json', async () => {
      mockDelete.mockResolvedValue({ message: 'Revoked' });
      setJsonMode(true);

      await keysCommand.parseAsync(['node', 'test', 'revoke', 'key-1', '--force']);

      expect(jsonOutputOf().data).toEqual({ status: 'revoked', id: 'key-1' });
    });

    it('refuses JSON-mode revoke without --force', async () => {
      setJsonMode(true);

      await expect(keysCommand.parseAsync(['node', 'test', 'revoke', 'key-1'])).rejects.toThrow(/without --force/);

      expect(mockDelete).not.toHaveBeenCalled();
    });
  });
});
