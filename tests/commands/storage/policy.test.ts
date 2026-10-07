import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPut = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: { create: () => Promise.resolve({ get: mockGet, post: mockPost, put: mockPut }) },
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
const { ApiError, UsageError, MissingFlagsError, ConfirmationRequiredError, ResourceNotFoundError } = await import(
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
      if (path === POLICY_PATH) return Promise.resolve(policies.length > 1 ? policies.shift() : policies[0]);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
  };

  const noApiCallWasMade = () => {
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
    [mockGet, mockPost, mockPut, mockConfirm, mockReadInput].forEach((m) => m.mockReset());
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

      it('asks about removing everything for an empty list as well', async () => {
        routeGet();
        confirmed();
        mockPut.mockResolvedValue(policyDoc('updating', []));

        await run('set', 'invoices', '--statements', '[]');

        expect(mockConfirm.mock.calls[0]![0].message).toMatch(/Remove ALL custom policy statements/);
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

      it('refuses to go ahead without --yes when it cannot ask, and saves nothing', async () => {
        routeGet();
        setTty(false);

        const attempt = run('set', 'invoices', '--statements', JSON.stringify([readStatement]));

        await expect(attempt).rejects.toThrow(ConfirmationRequiredError);
        await expect(attempt).rejects.toThrow(/without --force in non-interactive mode/);
        expect(mockConfirm).not.toHaveBeenCalled();
        expect(mockPut).not.toHaveBeenCalled();
      });

      it('exits 5 with that message when it cannot ask', async () => {
        routeGet();
        setTty(undefined);

        await expect(runCli('set', 'invoices', '--clear')).rejects.toMatchObject({ code: 5 });

        expect(err()).toMatch(/Refusing to proceed with replacing the custom policy statements of bucket invoices without --force/);
      });

      it('refuses under --json too, without --yes', async () => {
        routeGet();
        setJsonMode(true);

        await expect(run('set', 'invoices', '--clear')).rejects.toThrow(ConfirmationRequiredError);

        expect(mockPut).not.toHaveBeenCalled();
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

      it('does not claim the change reached the storage gateway', async () => {
        routeGet({ policies: [policyDoc('active', [readStatement])] });
        mockPut.mockResolvedValue(policyDoc('updating', [readStatement]));

        await run('set', 'invoices', ...flags);

        expect(everything()).not.toMatch(/successfully|has reached|was applied|is live|now applied/i);
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

      it('lets a failed poll through under --json too, as the JSON error, without a note on stderr', async () => {
        mockPut.mockResolvedValue(policyDoc('updating', [readStatement]));
        let calls = 0;
        mockGet.mockImplementation((path: string) => {
          if (path.startsWith('/api/v1/storage/buckets?')) return Promise.resolve(page([bucket]));
          calls++;
          return Promise.reject(new ApiError(500, 'server on fire'));
        });
        setJsonMode(true);

        await expect(runCli('set', 'invoices', ...flags)).rejects.toMatchObject({ code: 1 });

        expect(calls).toBe(1);
        expect(errSpy).not.toHaveBeenCalled();
        expect(jsonOut().error).toMatchObject({ code: 'api_error', status: 500, message: 'server on fire' });
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
        expect(result.meta).toEqual({ waited_ms: 4_000, settled: true });
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
        expect(result.meta).toEqual({ waited_ms: 4_000, settled: false });
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

      it('names every required flag that is missing', async () => {
        const attempt = run('grant', 'invoices', '--folder', 'f');

        await expect(attempt).rejects.toThrow(MissingFlagsError);
        await expect(attempt).rejects.toThrow(/--key, --level/);
        noApiCallWasMade();
      });

      it.each([
        ['--key', ['--folder', 'f', '--level', 'read'], '--key'],
        ['--level', ['--key', KEY_ID, '--folder', 'f'], '--level'],
      ])('asks for %s when it is the one missing', async (_name, flags, missing) => {
        const attempt = run('grant', 'invoices', ...flags);

        await expect(attempt).rejects.toThrow(MissingFlagsError);
        await expect(attempt).rejects.toThrow(new RegExp(`flag in non-interactive mode: ${missing}$`));
      });

      it('never turns an empty folder into the whole bucket', async () => {
        routeGet();
        mockPost.mockResolvedValue(accepted());

        await expect(run('grant', 'invoices', '--key', KEY_ID, '--folder', '', '--level', 'read')).rejects.toThrow(UsageError);

        expect(mockPost).not.toHaveBeenCalled();
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
        expect(result.meta.settled).toBe(true);
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
