import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPut = vi.fn();
const mockDelete = vi.fn();
vi.mock('../../src/lib/api-client.js', () => ({
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

const { queueCommand } = await import('../../src/commands/queue/index.js');
const { appsCommand } = await import('../../src/commands/apps/index.js');
const { setJsonMode } = await import('../../src/lib/json-mode.js');

const sub = (group: { commands: ReadonlyArray<{ name(): string }> }) => group.commands.map((c) => c.name());
const run = (group: { parseAsync: (a: string[], o: object) => Promise<unknown> }, args: string[]) =>
  group.parseAsync(args, { from: 'user' });

describe('queue commands', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    [mockGet, mockPost, mockPut, mockDelete].forEach((m) => m.mockReset());
    process.exitCode = undefined;
    setJsonMode(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    setJsonMode(false);
  });

  it('exposes the full surface the API serves', () => {
    expect(sub(queueCommand)).toEqual(
      expect.arrayContaining([
        'ls', 'create', 'get', 'update', 'rm',
        'start', 'stop', 'connection-info', 'metrics',
        'diagnose', 'logs', 'events',
      ]),
    );
  });

  it('sends the documented create body', async () => {
    mockPost.mockResolvedValueOnce({ id: 'q-1', name: 'events', created_at: '2026-01-02T03:04:05Z' });

    await run(queueCommand, ['create', '--name', 'events', '--profile', 'small']);

    const [path, body] = mockPost.mock.calls[0] ?? [];
    expect(path).toBe('/api/v1/queue');
    expect(body).toMatchObject({ name: 'events', resource_profile: 'small', datacenter: 'fsn1' });
    // version is optional: sending null would fail validation rather than
    // letting the platform pick a default.
    expect(body).not.toHaveProperty('version');
  });

  /**
   * An update with no fields would PUT an empty body, which the API accepts as
   * a no-op — so the caller believes something changed when nothing did.
   */
  it('refuses an update with nothing to change', async () => {
    await run(queueCommand, ['update', 'events']);

    expect(process.exitCode).toBe(2);
    expect(mockPut).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.join(' ')).toMatch(/Nothing to update/);
  });

  it('points at operation.terminal rather than the status string after create', async () => {
    mockPost.mockResolvedValueOnce({ id: 'q-1', name: 'events', created_at: '2026-01-02T03:04:05Z' });

    await run(queueCommand, ['create', '--name', 'events', '--profile', 'small']);

    expect(logSpy.mock.calls.join('\n')).toContain('operation.terminal');
  });
});

describe('apps commands', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    [mockGet, mockPost, mockPut, mockDelete].forEach((m) => m.mockReset());
    process.exitCode = undefined;
    setJsonMode(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    setJsonMode(false);
  });

  it('exposes the full surface the API serves', () => {
    expect(sub(appsCommand)).toEqual(
      expect.arrayContaining([
        'catalog', 'ls', 'create', 'get', 'update', 'rm',
        'restart', 'credentials', 'metrics',
        'diagnose', 'logs', 'events',
      ]),
    );
  });

  /**
   * The API deliberately does not expose upgrade or rollback — the platform
   * reports the outcome but does not accept the decision. A command here would
   * have to lie about what it can do.
   */
  it('offers no upgrade or rollback, because the API does not', () => {
    expect(sub(appsCommand)).not.toContain('upgrade');
    expect(sub(appsCommand)).not.toContain('rollback');
  });

  it('sends every required field on create', async () => {
    mockPost.mockResolvedValueOnce({ id: 'a-1', name: 'blog', app_type: 'ghost', created_at: '2026-01-02T03:04:05Z' });

    await run(appsCommand, [
      'create', '--type', 'ghost', '--name', 'blog', '--subdomain', 'blog', '--profile', 'small',
    ]);

    const [path, body] = mockPost.mock.calls[0] ?? [];
    expect(path).toBe('/api/v1/apps');
    expect(body).toMatchObject({
      app_type: 'ghost',
      name: 'blog',
      subdomain: 'blog',
      resource_profile: 'small',
      datacenter: 'fsn1',
    });
  });

  /**
   * Credentials go to a terminal, which means scrollback and screen shares.
   * Saying so is cheap; discovering it later is not.
   */
  it('warns that printed credentials are now in terminal history', async () => {
    mockGet
      .mockResolvedValueOnce({ data: [{ id: 'a-1', name: 'blog' }] })
      .mockResolvedValueOnce({ username: 'admin', password: 'synthetic-not-real' });

    await run(appsCommand, ['credentials', 'blog']);

    expect(logSpy.mock.calls.join('\n')).toMatch(/terminal history/);
  });

  it('emits credentials as a bare envelope in JSON mode, with no warning noise', async () => {
    setJsonMode(true);
    mockGet
      .mockResolvedValueOnce({ data: [{ id: 'a-1', name: 'blog' }] })
      .mockResolvedValueOnce({ username: 'admin', password: 'synthetic-not-real' });

    await run(appsCommand, ['credentials', 'blog']);

    const emitted = JSON.parse(logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n'));
    expect(emitted.data.username).toBe('admin');
    expect(JSON.stringify(emitted)).not.toMatch(/terminal history/);
  });
});

describe('program registration', () => {
  it('registers queue and apps as top-level groups', async () => {
    const { buildProgram } = await import('../../src/program.js');
    const names = buildProgram().commands.map((c) => c.name());

    expect(names).toContain('queue');
    expect(names).toContain('apps');
  });
});
