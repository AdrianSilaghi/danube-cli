import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const OTHER_TEAM = 9;
const mockGet = vi.fn();
const mockPost = vi.fn();
const mockDelete = vi.fn();
const mockOtherDelete = vi.fn();
const createCalls: Array<unknown> = [];
vi.mock('../../src/lib/api-client.js', () => ({
  ApiClient: {
    // A client for another project is a different object, so a revoke can be seen going to the right one.
    create: (options?: { teamId?: number }) => {
      createCalls.push(options ?? null);
      return Promise.resolve(options?.teamId === OTHER_TEAM ? { delete: mockOtherDelete } : { get: mockGet, post: mockPost, delete: mockDelete });
    },
  },
}));

let configuredTeam: number | null = null;
vi.mock('../../src/lib/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/config.js')>()),
  readConfig: () => Promise.resolve(null),
  getTeamId: () => configuredTeam,
}));

// Where the CLI remembers its logins, in memory, and which Docker config directory this run has.
let store = new Map<string, Array<{ keyId: string; teamId: number | null }>>();
let dockerDir = '/home/u/.docker';
let writeFails = false;
// One mutex with the semantics of the real lock: a second acquirer waits for the release. `lockBusy` makes it give up instead.
let lockBusy = false;
let lockTail: Promise<void> = Promise.resolve();
const events: string[] = [];
vi.mock('../../src/lib/registry-logins.js', () => ({
  acquireLoginLock: () => {
    if (lockBusy) return Promise.resolve(null);
    let release!: () => void;
    const previous = lockTail;
    lockTail = new Promise<void>((resolve) => { release = resolve; });
    return previous.then(() => {
      events.push('lock');
      return { release: () => { events.push('release'); release(); return Promise.resolve(); } };
    });
  },
  dockerConfigDir: () => dockerDir,
  readLoginKeys: (dir: string, host: string) => Promise.resolve([...(store.get(`${dir}|${host}`) ?? [])]),
  writeLoginKeys: (dir: string, host: string, records: Array<{ keyId: string; teamId: number | null }>) => {
    events.push('record');
    if (writeFails) return Promise.reject(new Error('EACCES'));
    store.set(`${dir}|${host}`, [...records]);
    return Promise.resolve();
  },
}));

vi.mock('ora', () => ({
  default: () => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis() }),
}));

const mockDocker = vi.fn();
vi.mock('../../src/lib/docker-cli.js', () => ({ runDocker: (...args: unknown[]) => mockDocker(...args) }));

const { registryCommand } = await import('../../src/commands/registry/index.js');
const { keysCommand } = await import('../../src/commands/registry/keys.js');
const { setJsonMode } = await import('../../src/lib/json-mode.js');
const { ApiError } = await import('../../src/lib/errors.js');

const TOKEN = 'cr_TOKEN0123456789abcdefghijklmnopqrstuvwxyzABCD';
const key = {
  id: 'k-1', name: 'laptop', username: 'dd-safi4-laptop-abc123', scope: 'push_pull',
  last_used_at: null, expires_at: null, revoked_at: null, created_at: '2026-11-17T10:00:00+00:00',
};
/** Commander keeps parsed option values between parses; clear them so cases do not leak into each other. */
const resetOptions = () => {
  for (const cmd of [...registryCommand.commands.filter((c) => c.name() === 'login'), ...keysCommand.commands]) {
    for (const opt of cmd.options) cmd.setOptionValue(opt.attributeName(), undefined);
  }
};
const login = (args: string[]) => {
  resetOptions();
  return registryCommand.parseAsync(['login', ...args], { from: 'user' });
};

const HOST = 'cr.danubedata.ro';
const CURRENT_TEAM = 5;

describe('danube registry login', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    [mockGet, mockPost, mockDelete, mockDocker].forEach((m) => m.mockReset());
    store = new Map();
    dockerDir = '/home/u/.docker';
    writeFails = false;
    lockBusy = false;
    lockTail = Promise.resolve();
    events.length = 0;
    configuredTeam = null;
    createCalls.length = 0;
    mockOtherDelete.mockReset().mockResolvedValue({ data: key });
    mockGet.mockImplementation((path: string) =>
      Promise.resolve(path === '/api/v1/user/teams'
        ? { data: [], current_team_id: CURRENT_TEAM }
        : { success: true, data: { registry_host: HOST } }));
    mockPost.mockResolvedValue({ key, token: TOKEN });
    mockDocker.mockResolvedValue({ code: 0, stdout: 'Login Succeeded', stderr: '', timedOut: false });
    mockDelete.mockResolvedValue({ data: { ...key, revoked_at: '2026-11-17T10:05:00+00:00' } });
    setJsonMode(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setJsonMode(false);
  });

  const everythingPrinted = (): string => [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n');

  it('creates a push_pull key and signs docker in with the token on stdin only', async () => {
    await login(['--name', 'laptop']);

    expect(mockGet).toHaveBeenCalledWith('/api/v1/registry/context');
    // `login` expires its key after 90 days unless told otherwise.
    expect(mockPost).toHaveBeenCalledWith('/api/v1/registry/access-keys', { name: 'laptop', scope: 'push_pull', expires_at: expect.any(String) });
    expect(mockDocker).toHaveBeenNthCalledWith(1, ['--version'], undefined, { timeoutMs: 15_000 });
    expect(mockDocker).toHaveBeenNthCalledWith(2, ['login', 'cr.danubedata.ro', '-u', key.username, '--password-stdin'], TOKEN, { timeoutMs: 120_000 });
    // The token is the stdin argument and nowhere else.
    expect(JSON.stringify(mockDocker.mock.calls[1]![0])).not.toContain(TOKEN);
    expect(everythingPrinted()).not.toContain(TOKEN);
    expect(everythingPrinted()).toContain('Docker is signed in to cr.danubedata.ro');
    expect(everythingPrinted()).not.toContain('credential store');
  });

  it('defaults to a 90 day expiry, and --expires-at replaces it', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-17T10:00:00.000Z'), toFake: ['Date'] });
    try {
      await login(['--name', 'a']);
      await login(['--name', 'b', '--expires-at', '2027-01-31T00:00:00Z']);
    } finally {
      vi.useRealTimers();
    }

    expect(mockPost.mock.calls[0]![1]).toMatchObject({ expires_at: '2027-02-15T10:00:00.000Z' });
    expect(mockPost.mock.calls[1]![1]).toMatchObject({ expires_at: '2027-01-31T00:00:00.000Z' });
  });

  it('passes Docker warnings through, scrubbed of the token, and says how to renew', async () => {
    mockPost.mockResolvedValue({ key: { ...key, expires_at: '2027-02-15T10:00:00+00:00' }, token: TOKEN });
    mockDocker
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', timedOut: false })
      .mockResolvedValueOnce({ code: 0, stdout: 'Login Succeeded', stderr: `WARNING! Your credentials are stored unencrypted in '/home/u/.docker/config.json' ${TOKEN}`, timedOut: false });

    await login(['--name', 'laptop']);

    const shown = everythingPrinted();
    expect(shown).toContain("WARNING! Your credentials are stored unencrypted in '/home/u/.docker/config.json' ***");
    expect(shown).not.toContain(TOKEN);
    expect(shown).toContain('run danube registry login again');
  });

  it('maps --scope and --expires-in to the API fields, and names the key when --name is absent', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-17T10:00:00.000Z'), toFake: ['Date'] });
    try {
      await login(['--scope', 'pull', '--expires-in', '90d']);
    } finally {
      vi.useRealTimers();
    }

    const body = mockPost.mock.calls[0]![1] as { name: string; scope: string; expires_at: string };
    expect(body.scope).toBe('pull');
    expect(body.expires_at).toBe('2027-02-15T10:00:00.000Z');
    expect(body.name).toMatch(/^danube-cli-[A-Za-z0-9.-]+-20261117-100000$/);
    expect(body.name.length).toBeLessThanOrEqual(120);
  });

  it('takes an absolute --expires-at and a minutes --expires-in, as keys create does', async () => {
    await login(['--name', 'a', '--expires-at', '2027-01-31T00:00:00Z']);
    vi.useFakeTimers({ now: new Date('2026-11-17T10:00:00.000Z'), toFake: ['Date'] });
    try {
      await login(['--name', 'b', '--expires-in', '90m']);
    } finally {
      vi.useRealTimers();
    }

    expect(mockPost.mock.calls[0]![1]).toMatchObject({ expires_at: '2027-01-31T00:00:00.000Z' });
    expect(mockPost.mock.calls[1]![1]).toMatchObject({ expires_at: '2026-11-17T11:30:00.000Z' });
  });

  it('prints a JSON envelope without the token', async () => {
    setJsonMode(true);

    await login(['--name', 'laptop']);

    const out = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(out).toMatchObject({ success: true, data: { registry_host: 'cr.danubedata.ro', username: key.username, docker_login: 'succeeded', key: { id: 'k-1' } } });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it('shows when the key expires', async () => {
    mockPost.mockResolvedValue({ key: { ...key, expires_at: '2027-02-15T10:00:00+00:00' }, token: TOKEN });

    await login(['--name', 'laptop']);

    expect(everythingPrinted()).toContain('expires 2027-02-15T10:00:00+00:00');
  });

  it('refuses a bad scope or duration before any request', async () => {
    await expect(login(['--scope', 'admin'])).rejects.toThrow(/--scope is required: push_pull or pull/);
    await expect(login(['--expires-in', 'soon'])).rejects.toThrow(/Invalid duration 'soon'/);
    await expect(login(['--expires-in', '0d'])).rejects.toThrow(/--expires-in must be greater than zero/);
    await expect(login(['--expires-in', '1d', '--expires-at', '2027-01-01T00:00:00Z'])).rejects.toThrow(/either --expires-in or --expires-at/);
    await expect(login(['--expires-at', 'tomorrow-ish'])).rejects.toThrow(/Invalid --expires-at/);

    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('creates no key when docker cannot be run', async () => {
    mockDocker.mockResolvedValueOnce({ code: 127, stdout: '', stderr: 'broken', timedOut: false });

    await expect(login([])).rejects.toThrow(/Docker could not be run\. Fix it.*no key was created/);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('says the docker check ran out of time', async () => {
    mockDocker.mockResolvedValueOnce({ code: null, stdout: '', stderr: '', timedOut: true });

    await expect(login([])).rejects.toThrow(/did not answer in time/);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('revokes the key, and says why, when docker login runs out of time', async () => {
    mockDocker
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', timedOut: false })
      .mockResolvedValueOnce({ code: null, stdout: '', stderr: 'partial', timedOut: true });

    const failure = await login(['--name', 'laptop']).catch((e: Error) => e);

    expect(mockDelete).toHaveBeenCalledWith('/api/v1/registry/access-keys/k-1');
    expect((failure as Error).message).toContain('did not finish within 2 minutes and was stopped');
    expect((failure as Error).message).toContain('revoked again');
  });

  describe('renewing the login', () => {
    const recorded = (dir = '/home/u/.docker') => store.get(`${dir}|${HOST}`);
    const printedJson = () => JSON.parse(String(logSpy.mock.calls[0]![0])).data;

    it('records the new key against this Docker config and registry, and revokes nothing the first time', async () => {
      setJsonMode(true);

      await login(['--name', 'laptop']);

      expect(recorded()).toEqual([{ keyId: 'k-1', teamId: CURRENT_TEAM }]);
      expect(mockDelete).not.toHaveBeenCalled();
      expect(printedJson()).toMatchObject({ previous_key_revoked: null, previous_key_message: null, key_recorded: true });
    });

    it('revokes exactly the key the last login here recorded, and records the new one', async () => {
      store.set(`/home/u/.docker|${HOST}`, [{ keyId: 'k-old', teamId: CURRENT_TEAM }]);

      await login(['--name', 'laptop']);

      expect(mockDelete.mock.calls.map((c) => c[0])).toEqual(['/api/v1/registry/access-keys/k-old']);
      expect(recorded()).toEqual([{ keyId: 'k-1', teamId: CURRENT_TEAM }]);
      expect(everythingPrinted()).toContain('Revoked the key the earlier login here made.');
    });

    it('never lists keys or goes by name', async () => {
      store.set(`/home/u/.docker|${HOST}`, [{ keyId: 'k-old', teamId: CURRENT_TEAM }]);

      await login(['--name', 'danube-cli-anything-else']);

      expect(mockGet.mock.calls.map((c) => c[0]).filter((p) => String(p).startsWith('/api/v1/registry/access-keys'))).toEqual([]);
    });

    it('does not touch the key of another Docker config directory', async () => {
      store.set('/home/u/.docker|' + HOST, [{ keyId: 'k-home', teamId: CURRENT_TEAM }]);
      dockerDir = '/root/.docker';

      await login(['--name', 'laptop']);

      expect(mockDelete).not.toHaveBeenCalled();
      expect(recorded('/home/u/.docker')).toEqual([{ keyId: 'k-home', teamId: CURRENT_TEAM }]);
      expect(recorded('/root/.docker')).toEqual([{ keyId: 'k-1', teamId: CURRENT_TEAM }]);
    });

    it('revokes an old key in the project it belongs to, even when this login is for another', async () => {
      store.set(`/home/u/.docker|${HOST}`, [{ keyId: 'k-other-project', teamId: OTHER_TEAM }]);

      await login(['--name', 'laptop']);

      expect(createCalls).toContainEqual({ teamId: OTHER_TEAM });
      expect(mockOtherDelete).toHaveBeenCalledWith('/api/v1/registry/access-keys/k-other-project');
      expect(mockDelete).not.toHaveBeenCalled();
      expect(recorded()).toEqual([{ keyId: 'k-1', teamId: CURRENT_TEAM }]);
    });

    it('uses the project the request is scoped to, without asking the account', async () => {
      configuredTeam = 7;

      await login(['--name', 'laptop']);

      expect(recorded()).toEqual([{ keyId: 'k-1', teamId: 7 }]);
      expect(mockGet).not.toHaveBeenCalledWith('/api/v1/user/teams');
    });

    it('records no project when the account cannot say, and still revokes through the current client later', async () => {
      mockGet.mockImplementation((path: string) =>
        path === '/api/v1/user/teams' ? Promise.reject(new Error('offline')) : Promise.resolve({ success: true, data: { registry_host: HOST } }));
      store.set(`/home/u/.docker|${HOST}`, [{ keyId: 'k-old', teamId: null }]);

      await login(['--name', 'laptop']);

      expect(recorded()).toEqual([{ keyId: 'k-1', teamId: null }]);
      expect(mockDelete).toHaveBeenCalledWith('/api/v1/registry/access-keys/k-old');
    });

    it('records no project when the account answers without one, and reports a revoke failure that is not an Error', async () => {
      mockGet.mockImplementation((path: string) =>
        Promise.resolve(path === '/api/v1/user/teams' ? { data: [] } : { success: true, data: { registry_host: HOST } }));
      store.set(`/home/u/.docker|${HOST}`, [{ keyId: 'k-old', teamId: null }]);
      mockDelete.mockRejectedValue('plain string failure');

      await login(['--name', 'laptop']);

      expect(recorded()).toEqual([{ keyId: 'k-old', teamId: null }, { keyId: 'k-1', teamId: null }]);
      expect(errSpy.mock.calls.flat().join('\n')).toContain('(plain string failure)');
    });

    it('holds the lock from before the key is created until the record is written', async () => {
      mockPost.mockImplementation(() => {
        events.push('create-key');
        return Promise.resolve({ key, token: TOKEN });
      });
      mockDocker.mockImplementation((args: string[]) => {
        events.push(args[0] === 'login' ? 'docker-login' : 'docker-check');
        return Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false });
      });

      await login(['--name', 'laptop']);

      expect(events).toEqual(['docker-check', 'lock', 'create-key', 'docker-login', 'record', 'release']);
    });

    it('releases the lock when the key cannot be created', async () => {
      mockPost.mockRejectedValue(new ApiError(403, 'no'));

      await login(['--name', 'laptop']).catch(() => undefined);

      expect(events).toEqual(['lock', 'release']);
    });

    it('releases the lock when docker login fails', async () => {
      mockDocker.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', timedOut: false }).mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'no', timedOut: false });

      await login(['--name', 'laptop']).catch(() => undefined);

      expect(events).toEqual(['lock', 'release']);
    });

    it('revokes and records nothing when it cannot take the lock, and says so', async () => {
      setJsonMode(true);
      lockBusy = true;
      store.set(`/home/u/.docker|${HOST}`, [{ keyId: 'k-old', teamId: CURRENT_TEAM }]);

      await login(['--name', 'laptop']);

      // docker login still ran (the user asked for it), but nobody revoked anything on a stale view.
      expect(mockDocker).toHaveBeenCalledWith(expect.arrayContaining(['login']), TOKEN, expect.anything());
      expect(mockDelete).not.toHaveBeenCalled();
      expect(recorded()).toEqual([{ keyId: 'k-old', teamId: CURRENT_TEAM }]);
      expect(printedJson()).toMatchObject({ previous_key_revoked: null, key_recorded: false });
      expect(printedJson().previous_key_message).toContain('Another registry login is running here');
    });

    it('warns in the human output when it could not take the lock', async () => {
      lockBusy = true;

      await login(['--name', 'laptop']);

      expect(errSpy.mock.calls.flat().join('\n')).toContain('Another registry login is running here');
    });

    it('two logins at once cannot revoke the key Docker ends up holding', async () => {
      const keys = [{ ...key, id: 'k-A' }, { ...key, id: 'k-B' }];
      const tokens = ['cr_A_token', 'cr_B_token'];
      let created = 0;
      mockPost.mockImplementation(() => {
        const i = created++;
        return Promise.resolve({ key: keys[i], token: tokens[i] });
      });
      const dockerLogins: string[] = [];
      let inFlight = 0;
      mockDocker.mockImplementation(async (args: string[], stdin?: string) => {
        if (args[0] === 'login') {
          inFlight++;
          expect(inFlight).toBe(1); // never two docker logins at once
          await new Promise((resolve) => setTimeout(resolve, 10));
          dockerLogins.push(String(stdin));
          inFlight--;
        }
        return { code: 0, stdout: '', stderr: '', timedOut: false };
      });

      await Promise.all([login(['--name', 'one']), login(['--name', 'two'])]);

      const heldByDocker = dockerLogins.at(-1) === 'cr_A_token' ? 'k-A' : 'k-B';
      const deleted = mockDelete.mock.calls.map((c) => String(c[0]).split('/').pop());
      expect(deleted).not.toContain(heldByDocker);
      // The one that logged in last is the one recorded, and the one before it was revoked.
      expect(recorded()).toEqual([{ keyId: heldByDocker, teamId: CURRENT_TEAM }]);
      expect(deleted).toEqual([heldByDocker === 'k-A' ? 'k-B' : 'k-A']);
    });

    it('drops, and does not call revoked, a 404 for a key recorded without a project', async () => {
      setJsonMode(true);
      store.set(`/home/u/.docker|${HOST}`, [{ keyId: 'k-old', teamId: null }]);
      mockDelete.mockRejectedValue(new ApiError(404, 'Not found'));

      await login(['--name', 'laptop']);

      expect(printedJson()).toMatchObject({ previous_key_revoked: null });
      expect(printedJson().previous_key_message).toMatch(/not found in the current project.*another project.*danube registry keys ls --project <id>.*no longer tracked/);
      expect(recorded()).toEqual([{ keyId: 'k-1', teamId: CURRENT_TEAM }]);
    });

    it('warns about it in the human output, in the plural for several', async () => {
      store.set(`/home/u/.docker|${HOST}`, [{ keyId: 'k-a', teamId: null }, { keyId: 'k-b', teamId: null }]);
      mockDelete.mockRejectedValue(new ApiError(404, 'Not found'));

      await login(['--name', 'laptop']);

      expect(errSpy.mock.calls.flat().join('\n')).toContain('2 earlier login keys were not found in the current project; they may live in another project');
    });

    it('still says false when one key failed and another was not found', async () => {
      setJsonMode(true);
      store.set(`/home/u/.docker|${HOST}`, [{ keyId: 'k-a', teamId: null }, { keyId: 'k-b', teamId: CURRENT_TEAM }]);
      mockDelete.mockRejectedValueOnce(new ApiError(404, 'Not found')).mockRejectedValueOnce(new Error('boom'));

      await login(['--name', 'laptop']);

      expect(printedJson()).toMatchObject({ previous_key_revoked: false });
      expect(recorded()).toEqual([{ keyId: 'k-b', teamId: CURRENT_TEAM }, { keyId: 'k-1', teamId: CURRENT_TEAM }]);
    });

    it('treats a 404 on the old key as already gone', async () => {
      setJsonMode(true);
      store.set(`/home/u/.docker|${HOST}`, [{ keyId: 'k-old', teamId: CURRENT_TEAM }]);
      mockDelete.mockRejectedValue(new ApiError(404, 'Not found'));

      await login(['--name', 'laptop']);

      expect(printedJson()).toMatchObject({ previous_key_revoked: true });
      expect(recorded()).toEqual([{ keyId: 'k-1', teamId: CURRENT_TEAM }]);
    });

    it('warns, keeps the old key recorded for the next try, and still reports the login', async () => {
      store.set(`/home/u/.docker|${HOST}`, [{ keyId: 'k-old', teamId: CURRENT_TEAM }]);
      mockDelete.mockRejectedValue(new ApiError(500, 'server exploded'));

      await login(['--name', 'laptop']);

      expect(recorded()).toEqual([{ keyId: 'k-old', teamId: CURRENT_TEAM }, { keyId: 'k-1', teamId: CURRENT_TEAM }]);
      expect(errSpy.mock.calls.flat().join('\n')).toContain('Could not revoke an earlier login key (server exploded); the next login will try again.');
      expect(everythingPrinted()).toContain('Docker is signed in');
    });

    it('retries every recorded key, counts them, and reports the failure in JSON', async () => {
      setJsonMode(true);
      store.set(`/home/u/.docker|${HOST}`, [{ keyId: 'k-a', teamId: CURRENT_TEAM }, { keyId: 'k-b', teamId: CURRENT_TEAM }, { keyId: 'k-1', teamId: CURRENT_TEAM }]);
      mockDelete.mockResolvedValueOnce({ data: key }).mockRejectedValueOnce(new Error('boom'));

      await login(['--name', 'laptop']);

      // The new key's own id is never revoked, even if it was recorded already.
      expect(mockDelete).toHaveBeenCalledTimes(2);
      expect(printedJson()).toMatchObject({ previous_key_revoked: false });
      expect(printedJson().previous_key_message).toBe('Revoked the key the earlier login here made. Could not revoke an earlier login key (boom); the next login will try again.');
    });

    it('says so, and reports it in JSON, when the new key cannot be recorded', async () => {
      writeFails = true;

      await login(['--name', 'laptop']);
      expect(errSpy.mock.calls.flat().join('\n')).toContain('Could not record this key, so the next login will not revoke it.');

      setJsonMode(true);
      logSpy.mockClear();
      await login(['--name', 'laptop']);
      expect(printedJson()).toMatchObject({ key_recorded: false });
    });

    it('names how many when several earlier keys are revoked', async () => {
      store.set(`/home/u/.docker|${HOST}`, [{ keyId: 'k-a', teamId: CURRENT_TEAM }, { keyId: 'k-b', teamId: CURRENT_TEAM }]);
      mockDelete.mockResolvedValue({ data: key });

      await login(['--name', 'laptop']);

      expect(everythingPrinted()).toContain('Revoked the 2 keys the earlier login here made.');
    });

    it('warns in the plural when several cannot be revoked', async () => {
      store.set(`/home/u/.docker|${HOST}`, [{ keyId: 'k-a', teamId: CURRENT_TEAM }, { keyId: 'k-b', teamId: CURRENT_TEAM }]);
      mockDelete.mockRejectedValue(new Error('no'));

      await login(['--name', 'laptop']);

      expect(errSpy.mock.calls.flat().join('\n')).toContain('Could not revoke 2 earlier login keys (no; no)');
    });

    it('is not done when docker login failed: nothing recorded changes', async () => {
      store.set(`/home/u/.docker|${HOST}`, [{ keyId: 'k-old', teamId: CURRENT_TEAM }]);
      mockDocker.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', timedOut: false }).mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'no', timedOut: false });

      await login(['--name', 'laptop']).catch(() => undefined);

      expect(mockDelete.mock.calls.map((c) => c[0])).toEqual(['/api/v1/registry/access-keys/k-1']);
      expect(recorded()).toEqual([{ keyId: 'k-old', teamId: CURRENT_TEAM }]);
    });
  });

  it('creates no key when docker is not installed', async () => {
    mockDocker.mockRejectedValueOnce(new Error('spawn docker ENOENT'));

    await expect(login([])).rejects.toThrow(/Docker was not found on your PATH.*no key was created/);

    expect(mockPost).not.toHaveBeenCalled();
  });

  it('explains a 404 as a platform without the key API', async () => {
    mockPost.mockRejectedValue(new ApiError(404, 'Not Found'));

    await expect(login([])).rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('does not offer registry access keys') });
    expect(mockDocker).toHaveBeenCalledTimes(1);
  });

  it('explains a 403 as owner-only / registry:credentials', async () => {
    mockPost.mockRejectedValue(new ApiError(403, 'Only the project owner can manage registry access keys.'));

    await expect(login([])).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(/needs the project owner and an API token with the registry:credentials ability.*Only the project owner/),
    });
  });

  it('refuses an answer without a token, without calling docker login', async () => {
    mockPost.mockResolvedValue({ key });

    await expect(login([])).rejects.toThrow(/had no key or token.*danube registry keys ls/);
    expect(mockDocker).toHaveBeenCalledTimes(1);
  });

  it('shares the create call, and its explained 403, with keys create', async () => {
    mockPost.mockRejectedValue(new ApiError(403, 'Only the project owner can manage registry access keys.'));
    resetOptions();

    await expect(registryCommand.parseAsync(['keys', 'create', 'ci', '--scope', 'pull'], { from: 'user' })).rejects.toThrow(/registry:credentials/);
  });

  it('passes other API failures through untouched', async () => {
    const failure = new ApiError(422, 'Validation failed.', { name: ['This project already has a key with this name.'] });
    mockPost.mockRejectedValue(failure);

    await expect(login(['--name', 'taken'])).rejects.toBe(failure);
  });

  it('passes a non-API failure through untouched', async () => {
    mockPost.mockRejectedValue(new Error('Could not reach the API'));

    await expect(login([])).rejects.toThrow('Could not reach the API');
  });

  it('revokes the key again when docker login fails, and hides the token', async () => {
    mockDocker
      .mockResolvedValueOnce({ code: 0, stdout: 'Docker version 27', stderr: '', timedOut: false })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: `Error saving credentials: ${TOKEN}`, timedOut: false });

    const failure = await login(['--name', 'laptop']).catch((e: Error) => e);

    expect(mockDelete).toHaveBeenCalledWith('/api/v1/registry/access-keys/k-1');
    expect((failure as Error).message).toContain('docker login failed (exit 1): Error saving credentials: ***');
    expect((failure as Error).message).toContain("The key 'laptop' was created and has been revoked again.");
    expect((failure as Error).message).not.toContain('keys rm');
    expect((failure as Error).message).not.toContain(TOKEN);
  });

  it('names the key for a manual revoke only when the automatic revoke failed too', async () => {
    mockDocker.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', timedOut: false }).mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'denied', timedOut: false });
    mockDelete.mockRejectedValue(new ApiError(500, 'boom'));

    const failure = await login(['--name', 'laptop']).catch((e: Error) => e);

    expect((failure as Error).message).toContain("The key 'laptop' (id k-1) was created");
    expect((failure as Error).message).toContain('revoking it failed');
    expect((failure as Error).message).toContain('danube registry keys rm k-1');
  });

  it('reports a docker that dies mid-login with its own message', async () => {
    mockDocker.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', timedOut: false }).mockRejectedValueOnce(new Error('spawn docker EACCES'));

    await expect(login([])).rejects.toThrow(/docker login failed: spawn docker EACCES/);
  });

  it('says so when docker fails without output', async () => {
    mockDocker.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', timedOut: false }).mockResolvedValueOnce({ code: 2, stdout: '', stderr: '', timedOut: false });

    await expect(login([])).rejects.toThrow(/\(exit 2\): no output/);
  });
});
