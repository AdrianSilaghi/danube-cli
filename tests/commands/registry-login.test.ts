import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockDelete = vi.fn();
vi.mock('../../src/lib/api-client.js', () => ({
  ApiClient: { create: () => Promise.resolve({ get: mockGet, post: mockPost, delete: mockDelete }) },
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

describe('danube registry login', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    [mockGet, mockPost, mockDelete, mockDocker].forEach((m) => m.mockReset());
    mockGet.mockResolvedValue({ success: true, data: { registry_host: 'cr.danubedata.ro' } });
    mockPost.mockResolvedValue({ key, token: TOKEN });
    mockDocker.mockResolvedValue({ code: 0, stdout: 'Login Succeeded', stderr: '' });
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
    expect(mockDocker).toHaveBeenNthCalledWith(1, ['--version']);
    expect(mockDocker).toHaveBeenNthCalledWith(2, ['login', 'cr.danubedata.ro', '-u', key.username, '--password-stdin'], TOKEN);
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
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: 'Login Succeeded', stderr: `WARNING! Your credentials are stored unencrypted in '/home/u/.docker/config.json' ${TOKEN}` });

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
      .mockResolvedValueOnce({ code: 0, stdout: 'Docker version 27', stderr: '' })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: `Error saving credentials: ${TOKEN}` });

    const failure = await login(['--name', 'laptop']).catch((e: Error) => e);

    expect(mockDelete).toHaveBeenCalledWith('/api/v1/registry/access-keys/k-1');
    expect((failure as Error).message).toContain('docker login failed (exit 1): Error saving credentials: ***');
    expect((failure as Error).message).toContain("The key 'laptop' was created and has been revoked again.");
    expect((failure as Error).message).not.toContain('keys rm');
    expect((failure as Error).message).not.toContain(TOKEN);
  });

  it('names the key for a manual revoke only when the automatic revoke failed too', async () => {
    mockDocker.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }).mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'denied' });
    mockDelete.mockRejectedValue(new ApiError(500, 'boom'));

    const failure = await login(['--name', 'laptop']).catch((e: Error) => e);

    expect((failure as Error).message).toContain("The key 'laptop' (id k-1) was created");
    expect((failure as Error).message).toContain('revoking it failed');
    expect((failure as Error).message).toContain('danube registry keys rm k-1');
  });

  it('reports a docker that dies mid-login with its own message', async () => {
    mockDocker.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }).mockRejectedValueOnce(new Error('spawn docker EACCES'));

    await expect(login([])).rejects.toThrow(/docker login failed: spawn docker EACCES/);
  });

  it('says so when docker fails without output', async () => {
    mockDocker.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }).mockResolvedValueOnce({ code: 2, stdout: '', stderr: '' });

    await expect(login([])).rejects.toThrow(/\(exit 2\): no output/);
  });
});
