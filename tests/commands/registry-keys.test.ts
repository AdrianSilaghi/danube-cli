import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockDelete = vi.fn();
vi.mock('../../src/lib/api-client.js', () => ({
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

const { registryCommand } = await import('../../src/commands/registry/index.js');
const { keysCommand } = await import('../../src/commands/registry/keys.js');
const { setJsonMode } = await import('../../src/lib/json-mode.js');
const { ApiError, UsageError } = await import('../../src/lib/errors.js');

const TOKEN = 'cr_SHOWN-ONCE-0123456789';
const HOUR = 3_600_000;

const makeKey = (overrides = {}) => ({
  id: '01a082d0-975d-70a0-aecd-2740713017e4',
  name: 'ci',
  username: 'key-ci',
  scope: 'push_pull',
  last_used_at: null,
  expires_at: null,
  revoked_at: null,
  created_at: '2026-11-01T10:00:00Z',
  ...overrides,
});

const page = (items: unknown[]) => ({
  data: items,
  pagination: { current_page: 1, last_page: 1, per_page: 100, total: items.length },
});

/** Commander keeps parsed option values between parses; clear them so cases do not leak into each other. */
const resetOptions = () => {
  for (const cmd of keysCommand.commands) {
    for (const opt of cmd.options) cmd.setOptionValue(opt.attributeName(), undefined);
  }
};

const run = (...args: string[]) => registryCommand.parseAsync(['node', 'test', 'keys', ...args]);

describe('registry keys', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  const printed = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
  const json = () => JSON.parse(String(logSpy.mock.calls.at(-1)![0]));

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGet.mockReset();
    mockPost.mockReset();
    mockDelete.mockReset();
    setJsonMode(false);
    resetOptions();
  });

  afterEach(() => {
    setJsonMode(false);
    vi.restoreAllMocks();
  });

  describe('ls', () => {
    it('lists keys with their id, scope and state', async () => {
      mockGet.mockResolvedValue(
        page([
          makeKey(),
          makeKey({ id: 'rev-1', name: 'old', revoked_at: '2026-11-02T10:00:00Z' }),
          makeKey({ id: 'exp-1', name: 'stale', expires_at: '2020-01-01T00:00:00Z' }),
        ]),
      );

      await run('ls');

      expect(mockGet).toHaveBeenCalledWith('/api/v1/registry/access-keys?per_page=100&page=1');
      const out = printed();
      expect(out).toContain('01a082d0-975d-70a0-aecd-2740713017e4');
      expect(out).toContain('key-ci');
      expect(out).toContain('push_pull');
      expect(out).toContain('revoked');
      expect(out).toContain('expired');
    });

    it('sends active=true with --active', async () => {
      mockGet.mockResolvedValue(page([makeKey()]));

      await run('ls', '--active');

      expect(mockGet).toHaveBeenCalledWith('/api/v1/registry/access-keys?active=true&per_page=100&page=1');
    });

    it('says so when there are no keys', async () => {
      mockGet.mockResolvedValue(page([]));

      await run('ls');

      expect(printed()).toContain('No registry access keys found.');
    });

    it('emits the envelope with --json', async () => {
      setJsonMode(true);
      mockGet.mockResolvedValue(page([makeKey()]));

      await run('ls');

      expect(json()).toMatchObject({ success: true, error: null, meta: { count: 1 } });
      expect(json().data[0].name).toBe('ci');
    });
  });

  describe('create', () => {
    const answer = (keyOverrides = {}) => ({ key: makeKey(keyOverrides), token: TOKEN });

    it('shows the token once with the warning and a docker login hint that does not repeat it', async () => {
      mockPost.mockResolvedValue(answer());

      await run('create', 'ci', '--scope', 'push_pull');

      expect(mockPost).toHaveBeenCalledWith('/api/v1/registry/access-keys', { name: 'ci', scope: 'push_pull' });
      const out = printed();
      expect(out.split(TOKEN)).toHaveLength(2);
      expect(out).toContain('it will not be shown again');
      expect(out).toContain('echo "$TOKEN" | docker login cr.danubedata.ro -u key-ci --password-stdin');
    });

    it('returns the token in data with --json', async () => {
      setJsonMode(true);
      mockPost.mockResolvedValue(answer());

      await run('create', 'ci', '--scope', 'pull');

      expect(json()).toMatchObject({
        success: true,
        error: null,
        data: { id: '01a082d0-975d-70a0-aecd-2740713017e4', name: 'ci', username: 'key-ci', token: TOKEN },
      });
    });

    it('turns --expires-in into a date that far ahead', async () => {
      mockPost.mockResolvedValue(answer());
      const before = Date.now();

      await run('create', 'ci', '--scope', 'pull', '--expires-in', '24h');

      const sent = new Date(mockPost.mock.calls[0]![1].expires_at).getTime();
      expect(sent).toBeGreaterThanOrEqual(before + 24 * HOUR);
      expect(sent).toBeLessThanOrEqual(Date.now() + 24 * HOUR);
    });

    it('accepts days in --expires-in', async () => {
      mockPost.mockResolvedValue(answer());
      const before = Date.now();

      await run('create', 'ci', '--scope', 'pull', '--expires-in', '30d');

      const sent = new Date(mockPost.mock.calls[0]![1].expires_at).getTime();
      expect(sent).toBeGreaterThanOrEqual(before + 30 * 24 * HOUR);
    });

    it('sends --expires-at as an ISO date', async () => {
      mockPost.mockResolvedValue(answer());

      await run('create', 'ci', '--scope', 'pull', '--expires-at', '2027-01-31T00:00:00Z');

      expect(mockPost).toHaveBeenCalledWith('/api/v1/registry/access-keys', {
        name: 'ci',
        scope: 'pull',
        expires_at: '2027-01-31T00:00:00.000Z',
      });
    });

    it.each([
      ['no scope', ['create', 'ci']],
      ['an unknown scope', ['create', 'ci', '--scope', 'admin']],
      ['both expiry flags', ['create', 'ci', '--scope', 'pull', '--expires-in', '1h', '--expires-at', '2027-01-01']],
      ['an unreadable date', ['create', 'ci', '--scope', 'pull', '--expires-at', 'soon']],
      ['an unreadable duration', ['create', 'ci', '--scope', 'pull', '--expires-in', 'soon']],
    ])('refuses %s before calling the API', async (_label, args) => {
      await expect(run(...args)).rejects.toThrow(UsageError);

      expect(mockPost).not.toHaveBeenCalled();
    });

    it('passes a 422 (name taken) through without printing a token', async () => {
      mockPost.mockRejectedValue(
        new ApiError(422, 'This project already has a key with this name, perhaps a revoked one. Choose another name.'),
      );

      await expect(run('create', 'ci', '--scope', 'pull')).rejects.toThrow('Choose another name');

      expect(printed()).not.toContain('cr_');
    });

    it('fails clearly when a 2xx answer carries no token', async () => {
      mockPost.mockResolvedValue({ key: makeKey() });

      await expect(run('create', 'ci', '--scope', 'pull')).rejects.toThrow('danube registry keys ls');

      expect(printed()).not.toContain('undefined');
    });
  });

  describe('rm', () => {
    it('revokes by id and reports it', async () => {
      const revoked = makeKey({ revoked_at: '2026-11-03T10:00:00Z' });
      mockDelete.mockResolvedValue({ data: revoked });

      await run('rm', revoked.id, '--force');

      expect(mockDelete).toHaveBeenCalledWith(`/api/v1/registry/access-keys/${revoked.id}`);
      expect(printed()).toContain("Registry access key 'ci' revoked.");
    });

    it('is also reachable as revoke, with --json returning the key', async () => {
      setJsonMode(true);
      const revoked = makeKey({ revoked_at: '2026-11-03T10:00:00Z' });
      mockDelete.mockResolvedValue({ data: revoked });

      await run('revoke', revoked.id, '--yes');

      expect(json()).toMatchObject({ success: true, data: { id: revoked.id, revoked_at: revoked.revoked_at } });
    });

    it('passes a 404 through', async () => {
      mockDelete.mockRejectedValue(new ApiError(404, 'Not found'));

      await expect(run('rm', 'nope', '--force')).rejects.toThrow('Not found');
    });

    it('does not revoke without confirmation when it cannot prompt', async () => {
      await expect(run('rm', 'some-id')).rejects.toThrow();

      expect(mockDelete).not.toHaveBeenCalled();
    });
  });
});
