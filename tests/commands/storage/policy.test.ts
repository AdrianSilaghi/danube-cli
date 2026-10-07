import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPut = vi.fn();
const mockCreate = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: { create: (...args: unknown[]) => mockCreate(...args) },
}));

vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  }),
}));

const mockConfirm = vi.fn();
vi.mock('@inquirer/prompts', () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
  input: vi.fn(),
  select: vi.fn(),
}));

const mockReadInput = vi.fn();
vi.mock('../../../src/lib/read-input.js', () => ({
  STDIN_SOURCE: '-',
  readInput: (...args: unknown[]) => mockReadInput(...args),
}));

// The wait is logic about time: `sleep` moves a fake clock and nothing waits.
let now = 0;
const sleeps: number[] = [];
vi.mock('../../../src/lib/sleep.js', () => ({
  sleep: vi.fn(async (ms: number) => {
    sleeps.push(ms);
    now += ms;
  }),
}));

const { policyCommand } = await import('../../../src/commands/storage/policy.js');
const { storageCommand } = await import('../../../src/commands/storage/index.js');
const { setJsonMode } = await import('../../../src/lib/json-mode.js');
const { handleError } = await import('../../../src/lib/handle-error.js');
const { ApiError, NotAuthenticatedError, UsageError, MissingFlagsError, ConfirmationRequiredError, ResourceNotFoundError } = await import(
  '../../../src/lib/errors.js'
);

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

const ARN = 'arn:aws:iam:::user/team-4-sk-k3j9x2mq';
const KEY_ID = '3f0c6a52-0e4b-4a3a-9d56-7c1d2b1a0001';
const BUCKET_PATH = '/api/v1/storage/buckets/b-1';
const POLICY_PATH = `${BUCKET_PATH}/policy`;
const GRANTS_PATH = `${POLICY_PATH}/folder-grants`;

const bucket = { id: 'b-1', team_id: 4, name: 'invoices', status: 'active' };

const keyRow = (overrides: Record<string, unknown> = {}) => ({
  id: KEY_ID,
  team_id: 4,
  name: 'invoices-service',
  access_key_id: 'DDAKINVOICES0000001',
  arn: ARN,
  scope: 'none',
  status: 'active',
  is_expired: false,
  expires_at: null,
  last_used_at: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...overrides,
});

const readStatement = {
  Effect: 'Allow',
  Principal: { AWS: [ARN] },
  Action: ['s3:GetObject'],
  Resource: ['arn:aws:s3:::dd-4-invoices/invoices/*'],
};
const denyStatement = { Effect: 'Deny', Principal: '*', Action: ['s3:DeleteObject'] };

const effectiveDoc = { Version: '2012-10-17', Statement: [{ Sid: 'PlatformOwnerObjectTagging', Effect: 'Allow' }] };

const policyDoc = (status = 'active', statements: unknown[] = [], effective: unknown = effectiveDoc) => ({
  custom_policy_statements: statements,
  effective_policy: effective,
  status,
});

const page = (items: unknown[]) => ({
  data: items,
  pagination: { current_page: 1, last_page: 1, per_page: 100, total: items.length },
});

// eslint-disable-next-line no-control-regex
const plain = (text: string): string => text.replace(/\x1B\[[0-9;]*m/g, '');

describe('storage policy commands', () => {
  const originalExit = process.exit;
  const originalIsTTY = process.stdin.isTTY;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  const out = (): string => logSpy.mock.calls.map((c) => plain(String(c[0] ?? ''))).join('\n');
  const err = (): string => errSpy.mock.calls.map((c) => plain(String(c[0] ?? ''))).join('\n');
  const everything = (): string => `${out()}\n${err()}`;

  const jsonOut = (): { success: boolean; data: any; error: any; meta: any } =>
    JSON.parse(String(logSpy.mock.calls.at(-1)![0]));

  const run = (...args: string[]) => policyCommand.parseAsync(['node', 'test', ...args]);

  /** Runs a command the way `index.ts` does: a failure goes to handleError. */
  const runCli = async (...args: string[]): Promise<void> => {
    try {
      await run(...args);
    } catch (e) {
      handleError(e);
    }
  };

  /** The JSON body that really goes over the wire. */
  const wireBody = (mock: ReturnType<typeof vi.fn>, call = 0): unknown => JSON.parse(JSON.stringify(mock.mock.calls[call]![1]));

  /**
   * GET routes: the bucket list, the key list, and the policy, which answers
   * each document in `policies` in turn and then repeats the last.
   */
  const routeGet = (opts: { buckets?: unknown[]; keys?: unknown[]; policies?: unknown[] } = {}) => {
    const policies = [...(opts.policies ?? [policyDoc()])];
    mockGet.mockImplementation((path: string) => {
      if (path.startsWith('/api/v1/storage/buckets?')) return Promise.resolve(page(opts.buckets ?? [bucket]));
      if (path.startsWith('/api/v1/storage/access-keys?')) return Promise.resolve(page(opts.keys ?? [keyRow()]));
      if (/^\/api\/v1\/storage\/buckets\/[^/?]+\/policy$/.test(path)) return Promise.resolve(policies.length > 1 ? policies.shift() : policies[0]);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
  };

  /** Not a request, and not even a client: whatever refused did so before the API was in the picture. */
  const noApiCallWasMade = () => {
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPut).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  };

  const polls = (): number => mockGet.mock.calls.filter((c) => c[0] === POLICY_PATH).length;

  const setTty = (value: boolean | undefined) => Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exit = vi.fn().mockImplementation((code: number) => {
      throw new ExitError(code);
    }) as never;
    setTty(true);
    process.exitCode = undefined;
    [mockGet, mockPost, mockPut, mockCreate, mockConfirm, mockReadInput].forEach((m) => m.mockReset());
    mockCreate.mockImplementation(() => Promise.resolve({ get: mockGet, post: mockPost, put: mockPut }));
    now = 0;
    sleeps.length = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    process.exit = originalExit;
    process.exitCode = undefined;
    setJsonMode(false);
    setTty(originalIsTTY);
    vi.restoreAllMocks();
  });

  it('is registered under storage as policy, with get, set and grant', () => {
    const policy = storageCommand.commands.find((c) => c.name() === 'policy');

    expect(policy).toBeDefined();
    expect(policy!.commands.map((c) => c.name()).sort()).toEqual(['get', 'grant', 'set']);
  });

  describe('which bucket', () => {
    // These commands decide who may reach a bucket: a name that is not a bucket's name must not
    // land on the bucket whose id happens to begin with it (`cafe`, `dead`, `beef` are all hex).
    const lookalike = { ...bucket, id: 'cafe1234-0000-4000-8000-000000000001', name: 'invoices' };
    const commands: Array<[string, string[]]> = [
      ['get', ['get', 'cafe']],
      ['set', ['set', 'cafe', '--clear', '--yes']],
      ['grant', ['grant', 'cafe', '--key', KEY_ID, '--folder', 'f', '--level', 'read']],
    ];

    it.each(commands)('%s does not take the beginning of an id for a name', async (_name, args) => {
      routeGet({ buckets: [lookalike] });

      const attempt = run(...args);

      await expect(attempt).rejects.toThrow(ResourceNotFoundError);
      await expect(attempt).rejects.toThrow("bucket 'cafe' not found.");
      expect(mockPut).not.toHaveBeenCalled();
      expect(mockPost).not.toHaveBeenCalled();
      expect(mockGet.mock.calls.map((c) => c[0])).not.toContain(`/api/v1/storage/buckets/${lookalike.id}/policy`);
    });

    it.each(commands)('%s takes a full id', async (name, args) => {
      routeGet({ buckets: [lookalike] });
      mockPut.mockResolvedValue(policyDoc('updating'));
      mockPost.mockResolvedValue({ added_statements: [], warnings: [], ...policyDoc('updating') });

      await run(...args.map((a) => (a === 'cafe' ? lookalike.id : a)));

      const reached = [...mockGet.mock.calls, ...mockPut.mock.calls, ...mockPost.mock.calls].map((c) => c[0]);
      expect(reached.some((path) => String(path).startsWith(`/api/v1/storage/buckets/${lookalike.id}/policy`))).toBe(true);
      expect(name).toBeTruthy();
    });

    it.each(commands)('%s refuses two buckets with one name as a usage error that names them by id', async (_name, args) => {
      routeGet({
        buckets: [
          { ...bucket, id: 'aaaa0000-0000-4000-8000-000000000001', name: 'twin' },
          { ...bucket, id: 'bbbb0000-0000-4000-8000-000000000002', name: 'twin' },
        ],
      });

      const attempt = run(...args.map((a) => (a === 'cafe' ? 'twin' : a)));

      await expect(attempt).rejects.toThrow(UsageError);
      await expect(attempt).rejects.toThrow(/aaaa0000-0000-4000-8000-000000000001 {2}twin/);
      await expect(attempt).rejects.toThrow("Use the bucket's id.");
      expect(mockPut).not.toHaveBeenCalled();
      expect(mockPost).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('reads the policy of the bucket it resolved, by id', async () => {
      routeGet();

      await run('get', 'invoices');

      expect(mockGet).toHaveBeenCalledWith(POLICY_PATH);
    });

    it('prints the status, then the custom statements as pretty JSON', async () => {
      routeGet({ policies: [policyDoc('active', [readStatement, denyStatement])] });

      await run('get', 'invoices');

      expect(out()).toMatch(/Status\s+active/);
      expect(out()).toContain(JSON.stringify([readStatement, denyStatement], null, 2));
      expect(out().indexOf('Status')).toBeLessThan(out().indexOf('"Effect"'));
    });

    it('prints an empty list when the bucket has no custom statements', async () => {
      routeGet({ policies: [policyDoc('active', [])] });

      await run('get', 'invoices');

      expect(out()).toContain('Custom statements (0)');
      expect(out()).toContain('[]');
    });

    it('leaves the effective policy out unless asked', async () => {
      routeGet({ policies: [policyDoc('active', [readStatement])] });

      await run('get', 'invoices');

      expect(out()).not.toContain('PlatformOwnerObjectTagging');
      expect(out()).not.toContain('Effective policy');
    });

    it('prints the effective policy as well with --effective', async () => {
      routeGet({ policies: [policyDoc('active', [readStatement])] });

      await run('get', 'invoices', '--effective');

      expect(out()).toContain('Effective policy');
      expect(out()).toContain(JSON.stringify(effectiveDoc, null, 2));
      expect(out()).toContain(JSON.stringify([readStatement], null, 2));
    });

    it('says so when there is no effective policy', async () => {
      routeGet({ policies: [policyDoc('active', [], null)] });

      await run('get', 'invoices', '--effective');

      expect(out()).toMatch(/Effective policy[^\n]*\n[^\n]*none/);
    });

    it('explains an updating status', async () => {
      routeGet({ policies: [policyDoc('updating', [readStatement])] });

      await run('get', 'invoices');

      expect(out()).toMatch(/Status\s+updating/);
      expect(out()).toContain('on its way to the storage gateway');
    });

    it('prints the response as the data under --json', async () => {
      const doc = { ...policyDoc('active', [readStatement]), something_new: true };
      routeGet({ policies: [doc] });
      setJsonMode(true);

      await run('get', 'invoices');

      expect(jsonOut().success).toBe(true);
      expect(jsonOut().data).toEqual(doc);
    });

    it('prints the whole response under --json with --effective as well: nothing is left out without it', async () => {
      const doc = policyDoc('active', [readStatement]);
      routeGet({ policies: [doc] });
      setJsonMode(true);

      await run('get', 'invoices', '--effective');

      expect(jsonOut().data).toEqual(doc);
    });

    it('says which bucket the name resolved to, in the JSON meta', async () => {
      routeGet();
      setJsonMode(true);

      await run('get', 'invoices');

      expect(jsonOut().meta).toEqual({ bucket_id: 'b-1' });
    });

    it('takes the bucket by id as well as by name', async () => {
      routeGet();

      await run('get', 'b-1');

      expect(mockGet).toHaveBeenCalledWith(POLICY_PATH);
    });

    it('stops with a not-found error, before asking for any policy, when the bucket is unknown', async () => {
      routeGet();

      await expect(run('get', 'nope')).rejects.toThrow(ResourceNotFoundError);

      expect(mockGet.mock.calls.map((c) => c[0])).not.toContain(POLICY_PATH);
    });
  });

  describe('set', () => {
    const confirmed = () => mockConfirm.mockResolvedValue(true);

    describe('where the statements come from', () => {
      it('reads them from --file and replaces the custom statements with exactly that list', async () => {
        routeGet();
        mockReadInput.mockResolvedValue(JSON.stringify([readStatement, denyStatement]));
        mockPut.mockResolvedValue(policyDoc('updating', [readStatement, denyStatement]));

        await run('set', 'invoices', '--file', 'policy.json', '--yes');

        expect(mockReadInput).toHaveBeenCalledWith('policy.json');
        expect(mockPut).toHaveBeenCalledTimes(1);
        expect(mockPut.mock.calls[0]![0]).toBe(POLICY_PATH);
        expect(wireBody(mockPut)).toStrictEqual({ custom_policy_statements: [readStatement, denyStatement] });
      });

      it('reads the standard input for --file -', async () => {
        routeGet();
        mockReadInput.mockResolvedValue(JSON.stringify([readStatement]));
        mockPut.mockResolvedValue(policyDoc('updating', [readStatement]));

        await run('set', 'invoices', '--file', '-', '--yes');

        expect(mockReadInput).toHaveBeenCalledWith('-');
        expect(wireBody(mockPut)).toStrictEqual({ custom_policy_statements: [readStatement] });
      });

      it('takes the statements from --statements without reading a file', async () => {
        routeGet();
        mockPut.mockResolvedValue(policyDoc('updating', [denyStatement]));

        await run('set', 'invoices', '--statements', JSON.stringify([denyStatement]), '--yes');

        expect(mockReadInput).not.toHaveBeenCalled();
        expect(wireBody(mockPut)).toStrictEqual({ custom_policy_statements: [denyStatement] });
      });

      it('sends an empty list for --clear, without reading anything', async () => {
        routeGet();
        mockPut.mockResolvedValue(policyDoc('updating', []));

        await run('set', 'invoices', '--clear', '--yes');

        expect(mockReadInput).not.toHaveBeenCalled();
        expect(wireBody(mockPut)).toStrictEqual({ custom_policy_statements: [] });
      });

      it('sends the Statement list of a full policy document, and not the document', async () => {
        routeGet();
        const document = { Version: '2012-10-17', Statement: [readStatement] };
        mockReadInput.mockResolvedValue(JSON.stringify(document));
        mockPut.mockResolvedValue(policyDoc('updating', [readStatement]));

        await run('set', 'invoices', '--file', 'policy.json', '--yes');

        expect(wireBody(mockPut)).toStrictEqual({ custom_policy_statements: [readStatement] });
      });
    });

    describe('refusals made before anything is sent', () => {
      const badInput: Array<[string, string[], RegExp]> = [
        ['text that is not JSON', ['--statements', '[{"Effect":'], /not valid JSON/],
        ['an empty --statements', ['--statements', ''], /not valid JSON/],
        ['a bare string', ['--statements', '"Allow"'], /list of statements/],
        ['a single statement that is not wrapped in a list', ['--statements', JSON.stringify(readStatement)], /wrap/i],
        ['a document whose Statement is not a list', ['--statements', JSON.stringify({ Statement: readStatement })], /must be a list/],
        ['a list with something that is not an object in it', ['--statements', '[{"Effect":"Allow"}, 7]'], /position 1/],
      ];

      it.each(badInput)('refuses %s as a usage error and calls no API', async (_name, flags, message) => {
        const attempt = run('set', 'invoices', ...flags, '--yes');

        await expect(attempt).rejects.toThrow(UsageError);
        await expect(attempt).rejects.toThrow(message);
        noApiCallWasMade();
      });

      it('refuses a file that is not valid JSON, and says which file', async () => {
        mockReadInput.mockResolvedValue('{ nope');

        const attempt = run('set', 'invoices', '--file', 'broken.json', '--yes');

        await expect(attempt).rejects.toThrow(/--file broken\.json is not valid JSON/);
        noApiCallWasMade();
      });

      it('says "the standard input" when the bad JSON came from there', async () => {
        mockReadInput.mockResolvedValue('{ nope');

        await expect(run('set', 'invoices', '--file', '-', '--yes')).rejects.toThrow(/the standard input is not valid JSON/);
        noApiCallWasMade();
      });

      it('lets a file that cannot be read fail on its own, before any API call', async () => {
        mockReadInput.mockRejectedValue(new UsageError('Cannot read missing.json: ENOENT'));

        await expect(run('set', 'invoices', '--file', 'missing.json', '--yes')).rejects.toThrow(/Cannot read missing\.json/);
        noApiCallWasMade();
      });

      it('asks what the statements should be when none of --file, --statements and --clear is given', async () => {
        const attempt = run('set', 'invoices', '--yes');

        await expect(attempt).rejects.toThrow(UsageError);
        await expect(attempt).rejects.toThrow(/--file.*--statements.*--clear/);
        noApiCallWasMade();
      });

      it.each([
        ['--file and --statements', ['--file', 'p.json', '--statements', '[]']],
        ['--file and --clear', ['--file', 'p.json', '--clear']],
        ['--statements and --clear', ['--statements', '[]', '--clear']],
        ['all three', ['--file', 'p.json', '--statements', '[]', '--clear']],
      ])('refuses %s together', async (_name, flags) => {
        const attempt = run('set', 'invoices', ...flags, '--yes');

        await expect(attempt).rejects.toThrow(UsageError);
        await expect(attempt).rejects.toThrow(/only one of/);
        noApiCallWasMade();
        expect(mockReadInput).not.toHaveBeenCalled();
      });

      describe('an empty list', () => {
        // `--yes` skips the question, so an empty list would wipe every custom statement
        // for a script whose filter happened to select nothing. Removing them all is --clear.
        const EMPTY = 'The list is empty, which removes every custom statement; use --clear to do that on purpose.';

        it.each([
          ['an empty list', ['--statements', '[]']],
          ['a policy document with an empty Statement', ['--statements', '{"Version":"2012-10-17","Statement":[]}']],
        ])('is refused for %s, even with --yes', async (_name, flags) => {
          const attempt = run('set', 'invoices', ...flags, '--yes');

          await expect(attempt).rejects.toThrow(UsageError);
          await expect(attempt).rejects.toThrow(EMPTY);
          noApiCallWasMade();
        });

        it.each(['policy.json', '-'])('is refused from %s too', async (source) => {
          mockReadInput.mockResolvedValue('[]');

          await expect(run('set', 'invoices', '--file', source, '--yes')).rejects.toThrow(EMPTY);

          noApiCallWasMade();
        });

        it('is refused at a terminal as well, before the question is asked', async () => {
          await expect(run('set', 'invoices', '--statements', '[]')).rejects.toThrow(EMPTY);

          expect(mockConfirm).not.toHaveBeenCalled();
          noApiCallWasMade();
        });
      });

      it.each([
        ['--file', ['--file', 'a.json', '--file', 'b.json']],
        ['--statements', ['--statements', '[]', '--statements', '[]']],
        ['--wait-timeout', ['--clear', '--wait', '--wait-timeout', '5', '--wait-timeout', '6']],
      ])('refuses %s given twice, which would silently keep the last', async (flag, flags) => {
        const attempt = run('set', 'invoices', ...flags, '--yes');

        await expect(attempt).rejects.toThrow(UsageError);
        await expect(attempt).rejects.toThrow(`${flag} was given more than once; give it once.`);
        noApiCallWasMade();
        expect(mockReadInput).not.toHaveBeenCalled();
      });
    });

    describe('confirmation', () => {
      it('asks first, naming the bucket and how many statements replace the old ones, and goes ahead on yes', async () => {
        routeGet();
        confirmed();
        mockPut.mockResolvedValue(policyDoc('updating', [readStatement, denyStatement]));

        await run('set', 'invoices', '--statements', JSON.stringify([readStatement, denyStatement]));

        expect(mockConfirm).toHaveBeenCalledTimes(1);
        const { message, default: preselected } = mockConfirm.mock.calls[0]![0];
        expect(message).toContain('invoices');
        expect(message).toContain('2 statements');
        expect(preselected).toBe(false);
        expect(mockPut).toHaveBeenCalledTimes(1);
      });

      it('says "1 statement", not "1 statements"', async () => {
        routeGet();
        confirmed();
        mockPut.mockResolvedValue(policyDoc('updating', [readStatement]));

        await run('set', 'invoices', '--statements', JSON.stringify([readStatement]));

        expect(mockConfirm.mock.calls[0]![0].message).toMatch(/with 1 statement\?/);
      });

      it('asks about removing everything for --clear', async () => {
        routeGet();
        confirmed();
        mockPut.mockResolvedValue(policyDoc('updating', []));

        await run('set', 'invoices', '--clear');

        expect(mockConfirm.mock.calls[0]![0].message).toMatch(/Remove ALL custom policy statements of bucket invoices/);
      });

      it('asks about a file at a terminal, and goes ahead on yes: only the standard input cannot be asked about', async () => {
        routeGet();
        confirmed();
        mockReadInput.mockResolvedValue(JSON.stringify([readStatement]));
        mockPut.mockResolvedValue(policyDoc('updating', [readStatement]));

        await run('set', 'invoices', '--file', 'policy.json');

        expect(mockReadInput).toHaveBeenCalledWith('policy.json');
        expect(mockConfirm).toHaveBeenCalledTimes(1);
        expect(mockPut).toHaveBeenCalledTimes(1);
      });

      it('cancels, and saves nothing, when the answer is no', async () => {
        routeGet();
        mockConfirm.mockResolvedValue(false);

        await run('set', 'invoices', '--statements', JSON.stringify([readStatement]));

        expect(out()).toContain('Cancelled.');
        expect(mockPut).not.toHaveBeenCalled();
      });

      it.each(['--yes', '-y', '--force', '-f'])('does not ask with %s', async (flag) => {
        routeGet();
        mockPut.mockResolvedValue(policyDoc('updating', [readStatement]));

        await run('set', 'invoices', '--statements', JSON.stringify([readStatement]), flag);

        expect(mockConfirm).not.toHaveBeenCalled();
        expect(mockPut).toHaveBeenCalledTimes(1);
      });

      it('refuses to go ahead without --yes when it cannot ask, before it asks the API anything', async () => {
        setTty(false);

        const attempt = run('set', 'invoices', '--statements', JSON.stringify([readStatement]));

        await expect(attempt).rejects.toThrow(ConfirmationRequiredError);
        await expect(attempt).rejects.toThrow(/without --force in non-interactive mode/);
        expect(mockConfirm).not.toHaveBeenCalled();
        noApiCallWasMade();
      });

      it('does not even read the file first', async () => {
        setTty(false);

        await expect(run('set', 'invoices', '--file', 'policy.json')).rejects.toThrow(ConfirmationRequiredError);

        expect(mockReadInput).not.toHaveBeenCalled();
        noApiCallWasMade();
      });

      it('exits 5 with that message when it cannot ask', async () => {
        setTty(undefined);

        await expect(runCli('set', 'invoices', '--clear')).rejects.toMatchObject({ code: 5 });

        expect(err()).toMatch(/Refusing to proceed with replacing the custom policy statements of bucket invoices without --force/);
        noApiCallWasMade();
      });

      it('refuses under --json too, without --yes, before anything is sent', async () => {
        setJsonMode(true);

        await expect(run('set', 'invoices', '--clear')).rejects.toThrow(ConfirmationRequiredError);

        noApiCallWasMade();
      });

      describe('statements from the standard input', () => {
        // The question cannot be answered on a standard input that was read to its end: at a
        // terminal the person types the statements, ends the input, and the prompt then reads
        // the same ended input. It has to be said up front, before anything is read.
        const REFUSAL = 'Refusing to proceed with replacing the custom policy statements of bucket invoices: '
          + 'the statements come from the standard input, so there is nothing left to answer a confirmation on. '
          + 'Add --yes (or --force) to go ahead.';

        it('need --yes even at a terminal, and nothing is read, asked or sent without it', async () => {
          setTty(true);

          const attempt = run('set', 'invoices', '--file', '-');

          await expect(attempt).rejects.toThrow(ConfirmationRequiredError);
          await expect(attempt).rejects.toThrow(REFUSAL);
          expect(mockReadInput).not.toHaveBeenCalled();
          expect(mockConfirm).not.toHaveBeenCalled();
          noApiCallWasMade();
        });

        it('exit 5 with that message, under --json too', async () => {
          await expect(runCli('set', 'invoices', '--file', '-')).rejects.toMatchObject({ code: 5 });
          expect(err()).toContain(REFUSAL);

          setJsonMode(true);
          await expect(runCli('set', 'invoices', '--file', '-')).rejects.toMatchObject({ code: 5 });
          expect(jsonOut().error).toMatchObject({ code: 'confirmation_required', message: REFUSAL });
          noApiCallWasMade();
        });

        it.each(['--yes', '-y', '--force', '-f'])('go ahead with %s, and are read only then', async (flag) => {
          routeGet();
          mockReadInput.mockResolvedValue(JSON.stringify([readStatement]));
          mockPut.mockResolvedValue(policyDoc('updating', [readStatement]));

          await run('set', 'invoices', '--file', '-', flag);

          expect(mockReadInput).toHaveBeenCalledWith('-');
          expect(mockConfirm).not.toHaveBeenCalled();
          expect(mockPut).toHaveBeenCalledTimes(1);
        });
      });

      it('does not ask when the input is refused first', async () => {
        await expect(run('set', 'invoices', '--statements', 'nope')).rejects.toThrow(UsageError);

        expect(mockConfirm).not.toHaveBeenCalled();
      });
    });

    describe('what it says once the change is accepted', () => {
      it('says how many statements were saved, that the status is updating, what that means and how to wait', async () => {
        routeGet();
        mockPut.mockResolvedValue(policyDoc('updating', [readStatement, denyStatement]));

        await run('set', 'invoices', '--statements', JSON.stringify([readStatement, denyStatement]), '--yes');

        const output = everything();
        expect(output).toContain('Saved 2 custom statements for bucket invoices');
        expect(output).toMatch(/Status: updating/);
        expect(output).toContain('on its way to the storage gateway');
        expect(output).toContain('--wait');
        expect(output).toContain('danube storage policy get invoices');
        expect(mockGet.mock.calls.filter((c) => c[0] === POLICY_PATH)).toHaveLength(0);
      });

      it('says everything was removed for --clear', async () => {
        routeGet();
        mockPut.mockResolvedValue(policyDoc('updating', []));

        await run('set', 'invoices', '--clear', '--yes');

        expect(everything()).toContain('Removed all custom statements from bucket invoices');
      });

      it('prints the 202 document as the data under --json, and nothing else', async () => {
        routeGet();
        const accepted = policyDoc('updating', [readStatement]);
        mockPut.mockResolvedValue(accepted);
        setJsonMode(true);

        await run('set', 'invoices', '--statements', JSON.stringify([readStatement]), '--yes');

        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(jsonOut().data).toEqual(accepted);
        expect(jsonOut().error).toBeNull();
      });

      it('says which bucket the name resolved to, in the JSON meta', async () => {
        routeGet();
        mockPut.mockResolvedValue(policyDoc('updating', [readStatement]));
        setJsonMode(true);

        await run('set', 'invoices', '--statements', JSON.stringify([readStatement]), '--yes');

        expect(jsonOut().meta).toEqual({ bucket_id: 'b-1' });
      });

      describe('when the answer carries nothing', () => {
        // The change is made by now. An answer that is null or empty must not turn into a crash that never says so.
        it.each([['null', null], ['an empty object', {}]])('says it was accepted, and where to look, for %s', async (_name, body) => {
          routeGet();
          mockPut.mockResolvedValue(body);

          await run('set', 'invoices', '--clear', '--yes');

          expect(out()).toContain('Removed all custom statements from bucket invoices.');
          expect(everything()).toContain('The change was accepted; the answer carried no status.');
          expect(everything()).toContain('danube storage policy get invoices shows what is stored.');
          expect(everything()).not.toContain('undefined');
          expect(process.exitCode).toBeUndefined();
        });

        it('prints it as it is under --json', async () => {
          routeGet();
          mockPut.mockResolvedValue(null);
          setJsonMode(true);

          await run('set', 'invoices', '--clear', '--yes');

          expect(jsonOut()).toMatchObject({ success: true, data: null, meta: { bucket_id: 'b-1' } });
        });

        it('has nothing to print as data when the wait is cut off before any poll could answer', async () => {
          mockPut.mockResolvedValue(null);
          mockGet.mockImplementation((path: string, budgetMs?: number) => {
            if (path.startsWith('/api/v1/storage/buckets?')) return Promise.resolve(page([bucket]));
            now += budgetMs!;
            return Promise.reject(new Error(`Request timed out after ${budgetMs}ms: GET ${path}`));
          });
          setJsonMode(true);

          await run('set', 'invoices', '--clear', '--yes', '--wait', '--wait-timeout', '1');

          const result = jsonOut();
          expect(result.data).toBeNull();
          expect(result.error).toMatchObject({ code: 'storage.policy_wait_timeout', retryable: true });
          expect(process.exitCode).toBe(75);
        });

        it('waits all the same, since it cannot tell the change is no longer being applied', async () => {
          routeGet({ policies: [policyDoc('updating'), policyDoc('active')] });
          mockPut.mockResolvedValue(null);

          await run('set', 'invoices', '--clear', '--yes', '--wait');

          expect(polls()).toBe(2);
          expect(everything()).toContain('The change is no longer being applied.');
        });
      });

      it('names the status plainly when the answer is not updating', async () => {
        routeGet();
        mockPut.mockResolvedValue(policyDoc('active', [readStatement]));

        await run('set', 'invoices', '--statements', JSON.stringify([readStatement]), '--yes');

        expect(everything()).toMatch(/Status: active/);
        expect(everything()).not.toContain('on its way');
      });
    });

    describe('--wait', () => {
      const flags = ['--statements', JSON.stringify([readStatement]), '--yes', '--wait'];

      it('polls the policy every two seconds until it is no longer updating, then says what active means', async () => {
        routeGet({ policies: [policyDoc('updating'), policyDoc('updating'), policyDoc('active', [readStatement])] });
        mockPut.mockResolvedValue(policyDoc('updating', [readStatement]));

        await run('set', 'invoices', ...flags);

        expect(polls()).toBe(3);
        expect(sleeps).toEqual([2_000, 2_000, 2_000]);
        expect(process.exitCode).toBeUndefined();
        const output = everything();
        expect(output).toMatch(/Status: active/);
        expect(output).toContain('no longer being applied');
        expect(output).toContain('does not prove');
        expect(output).toContain('danube storage policy get invoices');
      });

      it('says what active means in these words, and claims nothing more about the storage gateway', async () => {
        routeGet({ policies: [policyDoc('active', [readStatement])] });
        mockPut.mockResolvedValue(policyDoc('updating', [readStatement]));

        await run('set', 'invoices', ...flags);

        expect(out().split('\n').slice(-3)).toEqual([
          'Status: active. The change is no longer being applied.',
          'That does not prove the storage gateway holds it: a change the gateway refused also ends as active.',
          'danube storage policy get invoices shows what is stored.',
        ]);
        expect(err()).not.toContain('gateway');
      });

      it('does not poll when the accepted change is already not updating', async () => {
        routeGet();
        mockPut.mockResolvedValue(policyDoc('active', [readStatement]));

        await run('set', 'invoices', ...flags);

        expect(polls()).toBe(0);
        expect(sleeps).toEqual([]);
      });

      it('gives up after a minute by default, says the change has not failed, and exits 75', async () => {
        routeGet({ policies: [policyDoc('updating')] });
        mockPut.mockResolvedValue(policyDoc('updating', [readStatement]));

        await run('set', 'invoices', ...flags);

        expect(polls()).toBe(30);
        expect(process.exitCode).toBe(75);
        expect(err()).toContain('Still updating after 60s');
        expect(err()).toContain('gave up waiting');
        expect(err()).toContain('has not failed');
        expect(err()).toContain('danube storage policy get invoices');
        expect(everything()).not.toContain('no longer being applied');
      });

      it.each([
        ['10', 5],
        ['10s', 5],
        ['1m', 30],
      ])('honours --wait-timeout %s', async (timeout, expectedPolls) => {
        routeGet({ policies: [policyDoc('updating')] });
        mockPut.mockResolvedValue(policyDoc('updating', [readStatement]));

        await run('set', 'invoices', ...flags, '--wait-timeout', timeout);

        expect(polls()).toBe(expectedPolls);
        expect(process.exitCode).toBe(75);
      });

      it('stops waiting on an error, says the change was accepted, and lets the error through', async () => {
        mockPut.mockResolvedValue(policyDoc('updating', [readStatement]));
        let calls = 0;
        mockGet.mockImplementation((path: string) => {
          if (path.startsWith('/api/v1/storage/buckets?')) return Promise.resolve(page([bucket]));
          calls++;
          return calls === 1 ? Promise.resolve(policyDoc('updating')) : Promise.reject(new ApiError(500, 'server on fire'));
        });

        await expect(run('set', 'invoices', ...flags)).rejects.toThrow('server on fire');

        expect(calls).toBe(2);
        expect(err()).toContain('The change was accepted');
        expect(err()).toContain('danube storage policy get invoices');
      });

      describe('a failed poll under --json', () => {
        // The change was accepted. A script that only saw {success: false, api_error} would
        // think it was not, and might send it again, or give up on it.
        const pollFailsWith = (failure: Error) => {
          mockPut.mockResolvedValue(policyDoc('updating', [readStatement]));
          mockGet.mockImplementation((path: string) =>
            path.startsWith('/api/v1/storage/buckets?') ? Promise.resolve(page([bucket])) : Promise.reject(failure));
          setJsonMode(true);
        };

        it('is ONE envelope that says the change was accepted, carries it, and sets the exit code instead of throwing', async () => {
          pollFailsWith(new ApiError(500, 'server on fire'));

          await run('set', 'invoices', ...flags);

          expect(logSpy).toHaveBeenCalledTimes(1);
          const result = jsonOut();
          expect(result.success).toBe(false);
          expect(result.data).toEqual(policyDoc('updating', [readStatement]));
          expect(result.error).toEqual({
            code: 'storage.policy_wait_failed',
            message: 'server on fire',
            retryable: true,
            status: 500,
          });
          expect(result.meta).toEqual({ bucket_id: 'b-1', accepted: true });
          expect(process.exitCode).toBe(1);
          expect(errSpy).not.toHaveBeenCalled();
        });

        it('keeps the message of a failure that was not even an Error', async () => {
          pollFailsWith('the pipe broke' as unknown as Error);

          await run('set', 'invoices', ...flags);

          expect(jsonOut().error).toMatchObject({ code: 'storage.policy_wait_failed', message: 'the pipe broke' });
        });

        it('carries the status and the Retry-After of a 429, so a script knows when to look again', async () => {
          pollFailsWith(new ApiError(429, 'Too Many Requests', undefined, undefined, undefined, 12));

          await run('set', 'invoices', ...flags);

          expect(jsonOut().error).toMatchObject({ code: 'storage.policy_wait_failed', status: 429, retry_after_seconds: 12, retryable: true });
        });

        it('has no status for a failure that was not an answer from the API', async () => {
          pollFailsWith(new Error('Could not reach GET http://x/policy (ECONNREFUSED).'));

          await run('set', 'invoices', ...flags);

          const { error } = jsonOut();
          expect(error.message).toBe('Could not reach GET http://x/policy (ECONNREFUSED).');
          expect(error).not.toHaveProperty('status');
          expect(error).not.toHaveProperty('retry_after_seconds');
          expect(process.exitCode).toBe(1);
        });

        it.each([
          ['a 404, as every other command exits for one', new ApiError(404, 'Not Found'), 4],
          ['a login that no longer works', new NotAuthenticatedError(), 3],
        ])('exits as the other commands do for %s', async (_what, failure, exitCode) => {
          pollFailsWith(failure);

          await run('set', 'invoices', ...flags);

          expect(process.exitCode).toBe(exitCode);
          expect(jsonOut().error.code).toBe('storage.policy_wait_failed');
        });
      });

      it('asks each poll to finish within the time that is left, so none runs past the ceiling', async () => {
        routeGet({ policies: [policyDoc('updating')] });
        mockPut.mockResolvedValue(policyDoc('updating', [readStatement]));

        await run('set', 'invoices', ...flags, '--wait-timeout', '10');

        const budgets = mockGet.mock.calls.filter((c) => c[0] === POLICY_PATH).map((c) => c[1]);
        expect(budgets).toEqual([8_000, 6_000, 4_000, 2_000, 1_000]);
      });

      it('names the other status when the bucket ends in one, and exits 1', async () => {
        routeGet({ policies: [policyDoc('error', [readStatement])] });
        mockPut.mockResolvedValue(policyDoc('updating', [readStatement]));

        await run('set', 'invoices', ...flags);

        expect(process.exitCode).toBe(1);
        expect(err()).toContain("status 'error'");
        expect(err()).toContain('may not have been applied');
        expect(everything()).not.toContain('no longer being applied');
      });

      it('prints one envelope under --json: the latest document, how long it waited and that it settled', async () => {
        routeGet({ policies: [policyDoc('updating'), policyDoc('active', [readStatement])] });
        mockPut.mockResolvedValue(policyDoc('updating', [readStatement]));
        setJsonMode(true);

        await run('set', 'invoices', ...flags);

        expect(logSpy).toHaveBeenCalledTimes(1);
        const result = jsonOut();
        expect(result.success).toBe(true);
        expect(result.data.status).toBe('active');
        expect(result.data.custom_policy_statements).toEqual([readStatement]);
        expect(result.meta).toEqual({ bucket_id: 'b-1', waited_ms: 4_000, settled: true });
        expect(process.exitCode).toBeUndefined();
      });

      it('reports a timeout under --json as a retryable error, with the last document, and exits 75', async () => {
        routeGet({ policies: [policyDoc('updating')] });
        mockPut.mockResolvedValue(policyDoc('updating', [readStatement]));
        setJsonMode(true);

        await run('set', 'invoices', ...flags, '--wait-timeout', '4');

        const result = jsonOut();
        expect(result.success).toBe(false);
        expect(result.error).toMatchObject({ code: 'storage.policy_wait_timeout', retryable: true });
        expect(result.data.status).toBe('updating');
        expect(result.meta).toEqual({ bucket_id: 'b-1', waited_ms: 4_000, settled: false });
        expect(process.exitCode).toBe(75);
      });

      it('reports another final status under --json as an error and exits 1', async () => {
        routeGet({ policies: [policyDoc('error')] });
        mockPut.mockResolvedValue(policyDoc('updating', [readStatement]));
        setJsonMode(true);

        await run('set', 'invoices', ...flags);

        expect(jsonOut().success).toBe(false);
        expect(jsonOut().error).toMatchObject({ code: 'storage.policy_not_active' });
        expect(process.exitCode).toBe(1);
      });

      it.each(['abc', '0', '-5', '1.5', '500ms', ''])('refuses --wait-timeout %j before it calls the API', async (value) => {
        const attempt = run('set', 'invoices', '--clear', '--yes', '--wait', '--wait-timeout', value);

        await expect(attempt).rejects.toThrow(UsageError);
        await expect(attempt).rejects.toThrow(/--wait-timeout/);
        noApiCallWasMade();
      });

      it('refuses --wait-timeout without --wait, rather than ignoring it', async () => {
        const attempt = run('set', 'invoices', '--clear', '--yes', '--wait-timeout', '30');

        await expect(attempt).rejects.toThrow(UsageError);
        await expect(attempt).rejects.toThrow(/--wait-timeout needs --wait/);
        noApiCallWasMade();
      });
    });

    describe('when the API refuses', () => {
      it('says the bucket policy editor may not be available when it answers 404, and exits 4', async () => {
        routeGet();
        mockPut.mockRejectedValue(new ApiError(404, 'Not Found'));

        await expect(runCli('set', 'invoices', '--clear', '--yes')).rejects.toMatchObject({ code: 4 });

        expect(err()).toMatch(/no such bucket/i);
        expect(err()).toContain('bucket policy editor is not available for this bucket or this platform');
      });

      it('says the token needs storage:read and storage:write when it answers 403', async () => {
        routeGet();
        mockPut.mockRejectedValue(new ApiError(403, 'Insufficient permissions'));

        await expect(runCli('set', 'invoices', '--clear', '--yes')).rejects.toMatchObject({ code: 1 });

        expect(err()).toContain('API Error (403): Insufficient permissions');
        expect(err()).toContain('storage:read');
        expect(err()).toContain('storage:write');
      });

      it('does not blame the token for a 403 that is about the person\'s role', async () => {
        routeGet();
        mockPut.mockRejectedValue(new ApiError(403, 'This action is unauthorized.'));

        await expect(runCli('set', 'invoices', '--clear', '--yes')).rejects.toMatchObject({ code: 1 });

        expect(err()).toContain('API Error (403): This action is unauthorized.');
        expect(err()).not.toContain('storage:');
      });

      describe('a 404 for a bucket the list said is not on the endpoint that supports policies', () => {
        it('says exactly that, and exits 4', async () => {
          routeGet({ buckets: [{ ...bucket, provider: 'minio' }] });
          mockPut.mockRejectedValue(new ApiError(404, 'Not Found'));

          await expect(runCli('set', 'invoices', '--clear', '--yes')).rejects.toMatchObject({ code: 4 });

          expect(err()).toContain("Bucket 'invoices' is not on the endpoint that supports bucket policies, so its policy cannot be read or changed.");
          expect(err()).not.toMatch(/no such bucket/i);
        });

        it('keeps both causes for a bucket that is on it', async () => {
          routeGet({ buckets: [{ ...bucket, provider: 'ceph' }] });
          mockPut.mockRejectedValue(new ApiError(404, 'Not Found'));

          await expect(runCli('set', 'invoices', '--clear', '--yes')).rejects.toMatchObject({ code: 4 });

          expect(err()).toMatch(/no such bucket/i);
        });

        it('says it for a read, and for the polls of a wait, too', async () => {
          routeGet({ buckets: [{ ...bucket, provider: 'minio' }] });
          mockGet.mockImplementation((path: string) =>
            path.startsWith('/api/v1/storage/buckets?') ? Promise.resolve(page([{ ...bucket, provider: 'minio' }])) : Promise.reject(new ApiError(404, 'Not Found')));

          await expect(runCli('get', 'invoices')).rejects.toMatchObject({ code: 4 });

          expect(err()).toContain('is not on the endpoint that supports bucket policies');
        });
      });

      it('says the policy is being applied, that nothing was saved, and when to try again, when it answers 409', async () => {
        routeGet();
        mockPut.mockRejectedValue(
          new ApiError(409, "The bucket's policy is being applied. Try again in a moment.", undefined, undefined, undefined, 5),
        );

        await expect(runCli('set', 'invoices', '--clear', '--yes')).rejects.toMatchObject({ code: 1 });

        expect(err()).toContain('API Error (409)');
        expect(err()).toContain("The bucket's policy is being applied");
        expect(err()).toMatch(/nothing was saved/i);
        expect(err()).toContain('Try again in 5 seconds');
        expect(err()).toContain('retryable: yes');
      });

      it('prints the field messages of a 422 the way the other commands do', async () => {
        routeGet();
        mockPut.mockRejectedValue(
          new ApiError(422, 'Validation failed.', {
            'custom_policy_statements.0.Principal': ['Principal "arn:aws:iam:::user/team-7-sk-zz99zz99" is not an access key of this team.'],
          }),
        );

        await expect(runCli('set', 'invoices', '--statements', JSON.stringify([readStatement]), '--yes'))
          .rejects.toMatchObject({ code: 1 });

        expect(err()).toContain('API Error (422): Validation failed.');
        expect(err()).toContain('custom_policy_statements.0.Principal: Principal "arn:aws:iam:::user/team-7-sk-zz99zz99" is not an access key of this team.');
      });

      it('passes a 422 about the bucket state through as it is', async () => {
        routeGet();
        mockPut.mockRejectedValue(new ApiError(422, 'Bucket cannot be modified in its current state'));

        await expect(runCli('set', 'invoices', '--clear', '--yes')).rejects.toMatchObject({ code: 1 });

        expect(err()).toContain('Bucket cannot be modified in its current state');
      });

      it('emits the mapped error as a JSON envelope under --json', async () => {
        routeGet();
        mockPut.mockRejectedValue(new ApiError(404, 'Not Found'));
        setJsonMode(true);

        await expect(runCli('set', 'invoices', '--clear', '--yes')).rejects.toMatchObject({ code: 4 });

        const result = jsonOut();
        expect(result.success).toBe(false);
        expect(result.error).toMatchObject({ code: 'api_error', status: 404, cause: { code: 'storage.bucket_policy_unavailable' } });
        expect(result.error.message).toMatch(/no such bucket/i);
      });
    });
  });

  describe('grant', () => {
    const accepted = (overrides: Record<string, unknown> = {}) => ({
      added_statements: [readStatement, denyStatement],
      warnings: [],
      ...policyDoc('updating', [readStatement, denyStatement]),
      ...overrides,
    });

    describe('what is sent', () => {
      it('sends the key id, the folder and the level for a folder, and no whole_bucket', async () => {
        routeGet();
        mockPost.mockResolvedValue(accepted());

        await run('grant', 'invoices', '--key', KEY_ID, '--folder', 'invoices/2026', '--level', 'readwrite');

        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockPost.mock.calls[0]![0]).toBe(GRANTS_PATH);
        expect(JSON.stringify(mockPost.mock.calls[0]![1])).toBe(JSON.stringify({ key_id: KEY_ID, folder: 'invoices/2026', level: 'readwrite' }));
        expect(wireBody(mockPost)).not.toHaveProperty('whole_bucket');
      });

      it('sends whole_bucket: true, and no folder at all, for --whole-bucket', async () => {
        routeGet();
        mockPost.mockResolvedValue(accepted());

        await run('grant', 'invoices', '--key', KEY_ID, '--whole-bucket', '--level', 'read');

        expect(JSON.stringify(mockPost.mock.calls[0]![1])).toBe(JSON.stringify({ key_id: KEY_ID, whole_bucket: true, level: 'read' }));
        expect(wireBody(mockPost)).not.toHaveProperty('folder');
      });

      it('sends the folder as it was typed: the API normalises it', async () => {
        routeGet();
        mockPost.mockResolvedValue(accepted());

        await run('grant', 'invoices', '--key', KEY_ID, '--folder', '/reports/2026/', '--level', 'full');

        expect(wireBody(mockPost)).toStrictEqual({ key_id: KEY_ID, folder: '/reports/2026/', level: 'full' });
      });

      it.each(['read', 'readwrite', 'full'])('sends the level %s', async (level) => {
        routeGet();
        mockPost.mockResolvedValue(accepted());

        await run('grant', 'invoices', '--key', KEY_ID, '--folder', 'f', '--level', level);

        expect(wireBody(mockPost)).toMatchObject({ level });
      });

      it('addresses the bucket it resolved by name', async () => {
        routeGet();
        mockPost.mockResolvedValue(accepted());

        await run('grant', 'invoices', '--key', KEY_ID, '--folder', 'f', '--level', 'read');

        expect(mockPost.mock.calls[0]![0]).toBe(GRANTS_PATH);
      });
    });

    describe('which key', () => {
      const grantFor = (reference: string) =>
        run('grant', 'invoices', '--key', reference, '--folder', 'f', '--level', 'read');

      it('sends the id of the key whichever way it was named: its id', async () => {
        routeGet();
        mockPost.mockResolvedValue(accepted());

        await grantFor(KEY_ID);

        expect(wireBody(mockPost)).toMatchObject({ key_id: KEY_ID });
      });

      it('sends the id of the key whichever way it was named: its S3 access key id', async () => {
        routeGet();
        mockPost.mockResolvedValue(accepted());

        await grantFor('DDAKINVOICES0000001');

        expect(wireBody(mockPost)).toMatchObject({ key_id: KEY_ID });
      });

      it('sends the id of the key whichever way it was named: its name', async () => {
        routeGet();
        mockPost.mockResolvedValue(accepted());

        await grantFor('invoices-service');

        expect(wireBody(mockPost)).toMatchObject({ key_id: KEY_ID });
      });

      it('never sends the S3 access key id as the key id', async () => {
        routeGet();
        mockPost.mockResolvedValue(accepted());

        await grantFor('DDAKINVOICES0000001');

        expect(JSON.stringify(mockPost.mock.calls[0]![1])).not.toContain('DDAKINVOICES0000001');
      });

      it('refuses to choose between two keys with the same name, names them by id and name, and sends nothing', async () => {
        const secret = 'wJalrXUtnFEMI/SHOULD-NEVER-BE-PRINTED';
        routeGet({
          keys: [
            keyRow({ id: 'k-1', name: 'twin', secret_access_key: secret }),
            keyRow({ id: 'k-2', name: 'twin', secret_access_key: secret }),
          ],
        });

        const attempt = grantFor('twin');

        await expect(attempt).rejects.toThrow(UsageError);
        await expect(attempt).rejects.toThrow(/k-1\s+twin/);
        await expect(attempt).rejects.toThrow(/k-2\s+twin/);
        await expect(attempt).rejects.not.toThrow(/wJalr/);
        expect(mockPost).not.toHaveBeenCalled();
      });

      it('stops when no key matches, naming what was asked for, and sends nothing', async () => {
        routeGet();

        const attempt = grantFor('nobody');

        await expect(attempt).rejects.toThrow(ResourceNotFoundError);
        await expect(attempt).rejects.toThrow(/'nobody'/);
        expect(mockPost).not.toHaveBeenCalled();
      });

      it('stops when the bucket is unknown, before it looks for the key', async () => {
        routeGet();

        await expect(run('grant', 'nope', '--key', KEY_ID, '--folder', 'f', '--level', 'read')).rejects.toThrow(ResourceNotFoundError);

        expect(mockGet.mock.calls.map((c) => c[0]).filter((p) => String(p).includes('access-keys'))).toHaveLength(0);
        expect(mockPost).not.toHaveBeenCalled();
      });
    });

    describe('refusals made before anything is sent', () => {
      const refused: Array<[string, string[], RegExp]> = [
        ['--folder together with --whole-bucket', ['--key', KEY_ID, '--folder', 'f', '--whole-bucket', '--level', 'read'], /either --folder.*or --whole-bucket, not both/],
        ['neither --folder nor --whole-bucket', ['--key', KEY_ID, '--level', 'read'], /--folder <path>.*--whole-bucket/],
        ['a level that does not exist', ['--key', KEY_ID, '--folder', 'f', '--level', 'admin'], /read, readwrite or full/],
        ['an empty folder, which is never the whole bucket', ['--key', KEY_ID, '--folder', '', '--level', 'read'], /folder is empty.*--whole-bucket/],
        ['a folder that is only slashes', ['--key', KEY_ID, '--folder', '//', '--level', 'read'], /folder is empty/],
        ['a folder that is only spaces', ['--key', KEY_ID, '--folder', '   ', '--level', 'read'], /folder is empty/],
        ['an empty folder together with --whole-bucket', ['--key', KEY_ID, '--folder', '', '--whole-bucket', '--level', 'read'], /not both/],
      ];

      it.each(refused)('refuses %s as a usage error and calls no API', async (_name, flags, message) => {
        const attempt = run('grant', 'invoices', ...flags);

        await expect(attempt).rejects.toThrow(UsageError);
        await expect(attempt).rejects.toThrow(message);
        noApiCallWasMade();
      });

      it('names every required flag that is missing, without saying it is about non-interactive mode: it never asks', async () => {
        const attempt = run('grant', 'invoices', '--folder', 'f');

        await expect(attempt).rejects.toThrow(MissingFlagsError);
        await expect(attempt).rejects.toThrow('Missing required flags: --key, --level');
        await expect(attempt).rejects.not.toThrow(/non-interactive/);
        noApiCallWasMade();
      });

      it.each([
        ['--key', ['--folder', 'f', '--level', 'read'], '--key'],
        ['--level', ['--key', KEY_ID, '--folder', 'f'], '--level'],
      ])('asks for %s when it is the one missing', async (_name, flags, missing) => {
        const attempt = run('grant', 'invoices', ...flags);

        await expect(attempt).rejects.toThrow(MissingFlagsError);
        await expect(attempt).rejects.toThrow(`Missing required flag: ${missing}`);
        noApiCallWasMade();
      });

      it.each([
        ['--key', ['--key', 'a', '--key', 'b', '--folder', 'f', '--level', 'read']],
        ['--folder', ['--key', KEY_ID, '--folder', 'a', '--folder', 'b', '--level', 'read']],
        ['--level', ['--key', KEY_ID, '--folder', 'f', '--level', 'read', '--level', 'full']],
        ['--wait-timeout', ['--key', KEY_ID, '--folder', 'f', '--level', 'read', '--wait', '--wait-timeout', '5', '--wait-timeout', '6']],
      ])('refuses %s given twice, which would silently keep the last', async (flag, flags) => {
        const attempt = run('grant', 'invoices', ...flags);

        await expect(attempt).rejects.toThrow(UsageError);
        await expect(attempt).rejects.toThrow(`${flag} was given more than once; give it once.`);
        noApiCallWasMade();
      });

      it('never turns an empty folder into the whole bucket', async () => {
        routeGet();
        mockPost.mockResolvedValue(accepted());

        await expect(run('grant', 'invoices', '--key', KEY_ID, '--folder', '', '--level', 'read')).rejects.toThrow(UsageError);

        noApiCallWasMade();
      });
    });

    describe('what it says once the grant is accepted', () => {
      it('says what was added, to whom, where and at what level, and what the status means', async () => {
        routeGet();
        mockPost.mockResolvedValue(accepted());

        await run('grant', 'invoices', '--key', 'invoices-service', '--folder', 'invoices/2026', '--level', 'readwrite');

        const output = out();
        expect(output).toContain('Added 2 statements to the policy of bucket invoices');
        expect(output).toMatch(/Key\s+invoices-service/);
        expect(output).toContain(KEY_ID);
        expect(output).toMatch(/Where\s+folder invoices\/2026/);
        expect(output).toMatch(/Level\s+readwrite/);
        expect(everything()).toMatch(/Status: updating/);
        expect(everything()).toContain('on its way to the storage gateway');
        expect(everything()).toContain('--wait');
      });

      it('says "1 statement", not "1 statements"', async () => {
        routeGet();
        mockPost.mockResolvedValue(accepted({ added_statements: [readStatement] }));

        await run('grant', 'invoices', '--key', KEY_ID, '--folder', 'f', '--level', 'read');

        expect(out()).toContain('Added 1 statement to the policy');
      });

      it('says the whole bucket for --whole-bucket', async () => {
        routeGet();
        mockPost.mockResolvedValue(accepted());

        await run('grant', 'invoices', '--key', KEY_ID, '--whole-bucket', '--level', 'full');

        expect(out()).toMatch(/Where\s+the whole bucket/);
        expect(out()).toMatch(/Level\s+full/);
      });

      it('says nothing was added when the policy already allowed it', async () => {
        routeGet();
        mockPost.mockResolvedValue(accepted({ added_statements: [] }));

        await run('grant', 'invoices', '--key', KEY_ID, '--folder', 'f', '--level', 'read');

        expect(out()).toContain('Nothing to add: the policy of bucket invoices already allows this');
        expect(out()).not.toContain('Added');
        expect(everything()).toMatch(/Status: updating/);
      });

      it('prints every warning, and only the ones there are', async () => {
        routeGet();
        const warnings = [
          'This key already reaches the whole bucket through its bucket permissions (read). The folder grant adds to that.',
          'A second warning.',
        ];
        mockPost.mockResolvedValue(accepted({ warnings }));

        await run('grant', 'invoices', '--key', KEY_ID, '--folder', 'f', '--level', 'read');

        for (const warning of warnings) expect(err()).toContain(warning);
        expect(err().match(/Warning:/g)).toHaveLength(2);
      });

      it('prints no warning line when there are none', async () => {
        routeGet();
        mockPost.mockResolvedValue(accepted({ warnings: [] }));

        await run('grant', 'invoices', '--key', KEY_ID, '--folder', 'f', '--level', 'read');

        expect(err()).not.toContain('Warning');
      });

      it('prints the response as the data under --json, warnings included', async () => {
        routeGet();
        const response = accepted({ warnings: ['A warning.'] });
        mockPost.mockResolvedValue(response);
        setJsonMode(true);

        await run('grant', 'invoices', '--key', KEY_ID, '--folder', 'f', '--level', 'read');

        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(jsonOut().data).toEqual(response);
      });

      it('says which bucket and which key the names resolved to, in the JSON meta', async () => {
        routeGet();
        mockPost.mockResolvedValue(accepted());
        setJsonMode(true);

        await run('grant', 'invoices', '--key', 'invoices-service', '--folder', 'f', '--level', 'read');

        expect(jsonOut().meta).toEqual({ bucket_id: 'b-1', key_id: KEY_ID });
      });
    });

    describe('what a grant does not do: narrow', () => {
      // A grant only adds. A key that already holds `full` on a folder and is granted `read`
      // there still holds `full`: the output must not read as if it had been set to `read`.
      const TWO_OTHERS = 'This key has 2 other statements in the policy; a grant only adds. To narrow its access replace the custom statements: danube storage policy set invoices.';
      const fullObjects = { Effect: 'Allow', Principal: { AWS: [ARN] }, Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: ['arn:aws:s3:::dd-4-invoices/invoices/*'] };
      const listing = { Effect: 'Allow', Principal: { AWS: [ARN] }, Action: ['s3:ListBucket'], Resource: ['arn:aws:s3:::dd-4-invoices'] };
      const someoneElse = { Effect: 'Allow', Principal: { AWS: ['arn:aws:iam:::user/team-4-sk-someone1'] }, Action: ['s3:GetObject'] };
      const everyone = { Effect: 'Deny', Principal: '*', Action: ['s3:DeleteBucket'] };

      it('says so when the key already has other statements, naming how many and how to narrow', async () => {
        routeGet();
        mockPost.mockResolvedValue(accepted({
          added_statements: [readStatement],
          custom_policy_statements: [fullObjects, listing, readStatement],
        }));

        await run('grant', 'invoices', '--key', KEY_ID, '--folder', 'invoices', '--level', 'read');

        expect(err()).toContain(TWO_OTHERS);
      });

      it('says "1 other statement" for one', async () => {
        routeGet();
        mockPost.mockResolvedValue(accepted({
          added_statements: [readStatement],
          custom_policy_statements: [fullObjects, readStatement],
        }));

        await run('grant', 'invoices', '--key', KEY_ID, '--folder', 'invoices', '--level', 'read');

        expect(err()).toContain('This key has 1 other statement in the policy; a grant only adds.');
      });

      it('counts only statements that name this key, whether the principal is a list or a single ARN', async () => {
        routeGet();
        const named = { ...fullObjects, Principal: { AWS: ARN } };
        mockPost.mockResolvedValue(accepted({
          added_statements: [readStatement],
          custom_policy_statements: [named, someoneElse, everyone, readStatement],
        }));

        await run('grant', 'invoices', '--key', KEY_ID, '--folder', 'invoices', '--level', 'read');

        expect(err()).toContain('This key has 1 other statement in the policy');
      });

      it('says nothing for a key whose only statements are the ones just added', async () => {
        routeGet();
        mockPost.mockResolvedValue(accepted({
          added_statements: [readStatement, listing],
          custom_policy_statements: [someoneElse, readStatement, listing],
        }));

        await run('grant', 'invoices', '--key', KEY_ID, '--folder', 'invoices', '--level', 'read');

        expect(err()).not.toContain('a grant only adds');
      });

      it('says nothing when nothing was added: the statements it finds are the grant being asked again', async () => {
        routeGet();
        mockPost.mockResolvedValue(accepted({
          added_statements: [],
          custom_policy_statements: [readStatement, listing],
        }));

        await run('grant', 'invoices', '--key', KEY_ID, '--folder', 'invoices', '--level', 'read');

        expect(out()).toContain('Nothing to add');
        expect(err()).not.toContain('a grant only adds');
      });

      it('says nothing for a key that has no ARN of its own to look for', async () => {
        routeGet({ keys: [keyRow({ arn: null })] });
        mockPost.mockResolvedValue(accepted({
          added_statements: [readStatement],
          custom_policy_statements: [fullObjects, readStatement],
        }));

        await run('grant', 'invoices', '--key', KEY_ID, '--folder', 'invoices', '--level', 'read');

        expect(err()).not.toContain('a grant only adds');
      });

      it('prints it after the warnings, and not under --json, where the response carries the statements', async () => {
        routeGet();
        mockPost.mockResolvedValue(accepted({
          added_statements: [readStatement],
          warnings: ['A warning.'],
          custom_policy_statements: [fullObjects, listing, readStatement],
        }));

        await run('grant', 'invoices', '--key', KEY_ID, '--folder', 'invoices', '--level', 'read');
        expect(err().indexOf('A warning.')).toBeLessThan(err().indexOf('a grant only adds'));

        errSpy.mockClear();
        setJsonMode(true);
        await run('grant', 'invoices', '--key', KEY_ID, '--folder', 'invoices', '--level', 'read');
        expect(errSpy).not.toHaveBeenCalled();
      });
    });

    describe('when the answer carries too little', () => {
      // The grant is applied by now: a missing field must not become a crash that never says so.
      it('names what it cannot say, instead of "nothing to add", when added_statements is missing', async () => {
        routeGet();
        mockPost.mockResolvedValue({ ...policyDoc('updating', [readStatement]) });

        await run('grant', 'invoices', '--key', KEY_ID, '--folder', 'f', '--level', 'read');

        expect(out()).toContain('The grant was accepted, but the answer did not say what was added.');
        expect(out()).not.toContain('Nothing to add');
        expect(out()).toMatch(/Where\s+folder f/);
        expect(everything()).toMatch(/Status: updating/);
      });

      it('takes missing warnings for none', async () => {
        routeGet();
        mockPost.mockResolvedValue({ added_statements: [readStatement], ...policyDoc('updating', [readStatement]) });

        await run('grant', 'invoices', '--key', KEY_ID, '--folder', 'f', '--level', 'read');

        expect(out()).toContain('Added 1 statement to the policy');
        expect(err()).not.toContain('Warning');
      });

      it.each([['null', null], ['an empty object', {}]])('says it was accepted, and where to look, for %s', async (_name, body) => {
        routeGet();
        mockPost.mockResolvedValue(body);

        await run('grant', 'invoices', '--key', KEY_ID, '--whole-bucket', '--level', 'full');

        expect(out()).toContain('The grant was accepted, but the answer did not say what was added.');
        expect(out()).toMatch(/Where\s+the whole bucket/);
        expect(everything()).toContain('The change was accepted; the answer carried no status.');
        expect(everything()).not.toContain('undefined');
        expect(process.exitCode).toBeUndefined();
      });

      it('prints a null answer as it is under --json, with what the names resolved to', async () => {
        routeGet();
        mockPost.mockResolvedValue(null);
        setJsonMode(true);

        await run('grant', 'invoices', '--key', KEY_ID, '--folder', 'f', '--level', 'read');

        expect(jsonOut()).toMatchObject({ success: true, data: null, meta: { bucket_id: 'b-1', key_id: KEY_ID } });
      });
    });

    describe('--wait', () => {
      const flags = ['--key', KEY_ID, '--folder', 'f', '--level', 'read', '--wait'];

      it('polls until the status is no longer updating, and then says what active means', async () => {
        routeGet({ policies: [policyDoc('updating'), policyDoc('active', [readStatement])] });
        mockPost.mockResolvedValue(accepted());

        await run('grant', 'invoices', ...flags);

        expect(polls()).toBe(2);
        expect(sleeps).toEqual([2_000, 2_000]);
        expect(everything()).toContain('no longer being applied');
        expect(everything()).toContain('Added 2 statements');
        expect(process.exitCode).toBeUndefined();
      });

      it('keeps what only the grant answer carries in the JSON data, with the latest status', async () => {
        routeGet({ policies: [policyDoc('active', [readStatement, denyStatement])] });
        mockPost.mockResolvedValue(accepted({ warnings: ['A warning.'] }));
        setJsonMode(true);

        await run('grant', 'invoices', ...flags);

        const result = jsonOut();
        expect(result.data.status).toBe('active');
        expect(result.data.added_statements).toEqual([readStatement, denyStatement]);
        expect(result.data.warnings).toEqual(['A warning.']);
        expect(result.meta).toEqual({ bucket_id: 'b-1', key_id: KEY_ID, waited_ms: 2_000, settled: true });
      });

      it('gives up at --wait-timeout and exits 75', async () => {
        routeGet({ policies: [policyDoc('updating')] });
        mockPost.mockResolvedValue(accepted());

        await run('grant', 'invoices', ...flags, '--wait-timeout', '6');

        expect(polls()).toBe(3);
        expect(process.exitCode).toBe(75);
        expect(err()).toContain('Still updating after 6s');
      });

      it('prints the warnings before it starts to wait, so a long wait does not hide them', async () => {
        routeGet({ policies: [policyDoc('updating'), policyDoc('active')] });
        mockPost.mockResolvedValue(accepted({ warnings: ['Mind this.'] }));

        await run('grant', 'invoices', ...flags);

        expect(err()).toContain('Mind this.');
        expect(err()).toContain('Waiting for the change to finish being applied');
        expect(err().indexOf('Mind this.')).toBeLessThan(err().indexOf('Waiting for the change'));
      });

      it('says it is waiting, on stderr, with how long it will wait at most', async () => {
        routeGet({ policies: [policyDoc('active')] });
        mockPost.mockResolvedValue(accepted());

        await run('grant', 'invoices', ...flags, '--wait-timeout', '90');

        expect(err()).toContain('Waiting for the change to finish being applied (up to 90s)');
        expect(out()).not.toContain('Waiting');
      });

      it('says nothing about waiting under --json', async () => {
        routeGet({ policies: [policyDoc('active')] });
        mockPost.mockResolvedValue(accepted());
        setJsonMode(true);

        await run('grant', 'invoices', ...flags);

        expect(errSpy).not.toHaveBeenCalled();
      });

      it('refuses a bad --wait-timeout before it calls the API', async () => {
        const attempt = run('grant', 'invoices', ...flags, '--wait-timeout', 'soon');

        await expect(attempt).rejects.toThrow(UsageError);
        noApiCallWasMade();
      });

      it('refuses --wait-timeout without --wait', async () => {
        const attempt = run('grant', 'invoices', '--key', KEY_ID, '--folder', 'f', '--level', 'read', '--wait-timeout', '30');

        await expect(attempt).rejects.toThrow(/--wait-timeout needs --wait/);
        noApiCallWasMade();
      });
    });

    describe('when the API refuses', () => {
      const attempt = () => runCli('grant', 'invoices', '--key', KEY_ID, '--folder', 'f', '--level', 'read');

      it('names both possible causes of a 404, and exits 4', async () => {
        routeGet();
        mockPost.mockRejectedValue(new ApiError(404, 'Bucket not found'));

        await expect(attempt()).rejects.toMatchObject({ code: 4 });

        expect(err()).toMatch(/no such bucket/i);
        expect(err()).toContain('bucket policy editor is not available for this bucket or this platform');
      });

      it('says a change needs storage:read and storage:write on a 403', async () => {
        routeGet();
        mockPost.mockRejectedValue(new ApiError(403, 'Insufficient permissions'));

        await expect(attempt()).rejects.toMatchObject({ code: 1 });

        expect(err()).toContain('storage:read');
        expect(err()).toContain('storage:write');
      });

      it('says the policy is being applied and to retry in a moment on a 409 with no Retry-After', async () => {
        routeGet();
        mockPost.mockRejectedValue(new ApiError(409, 'busy'));

        await expect(attempt()).rejects.toMatchObject({ code: 1 });

        expect(err()).toContain('Try again in a moment');
      });

      it('prints the field messages of a 422', async () => {
        routeGet();
        mockPost.mockRejectedValue(new ApiError(422, 'Validation failed.', { key_id: ['Choose an active access key of this team.'] }));

        await expect(attempt()).rejects.toMatchObject({ code: 1 });

        expect(err()).toContain('key_id: Choose an active access key of this team.');
      });
    });
  });
});
