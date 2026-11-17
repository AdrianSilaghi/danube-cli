import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, stat, writeFile, chmod, rm, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPut = vi.fn();
const mockDelete = vi.fn();
const mockGetText = vi.fn();
vi.mock('../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet, post: mockPost, put: mockPut, delete: mockDelete, getText: mockGetText }),
  },
}));

const confirmMock = vi.fn();
vi.mock('@inquirer/prompts', () => ({ confirm: confirmMock, input: vi.fn() }));

const { queueCommand } = await import('../../src/commands/queue/index.js');
const { parseAcl, parseAcls, formatAcl } = await import('../../src/commands/queue/acl.js');
const { setJsonMode } = await import('../../src/lib/json-mode.js');
const { UsageError, ConfirmationRequiredError, ApiError } = await import('../../src/lib/errors.js');
const { handleError } = await import('../../src/lib/handle-error.js');

const run = (args: string[]) => queueCommand.parseAsync(args, { from: 'user' });

const Q = '/api/v1/queue/q-1';
const queueList = { data: [{ id: 'q-1', name: 'ev', provider: 'kafka' }], pagination: { last_page: 1, total: 1 } };
const user = (over: Record<string, unknown> = {}) => ({
  id: 'u-1',
  name: 'orders-app',
  username: 'kafka-ev.orders-app',
  status: 'active',
  status_message: null,
  acls: [{ resource_type: 'topic', name: 'orders.', pattern: 'prefix', operations: ['read', 'describe'] }],
  created_at: '2026-01-02T03:04:05Z',
  ...over,
});
const registry = (over: Record<string, unknown> = {}) => ({
  enabled: false,
  status: 'disabled',
  url: null,
  username: 'registry',
  password: null,
  monthly_price_cents: 499,
  enabled_at: null,
  ...over,
});

/** Route GETs by path; the queue list answers the name lookup. */
function routeGet(routes: Record<string, unknown>) {
  mockGet.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/queue?')) return Promise.resolve(queueList);
    if (path in routes) return Promise.resolve(routes[path]);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
}

describe('parseAcl', () => {
  it('parses a four-part rule', () => {
    expect(parseAcl('topic:orders.:prefix:read,describe')).toEqual({
      resource_type: 'topic', name: 'orders.', pattern: 'prefix', operations: ['read', 'describe'],
    });
  });

  it('defaults the pattern to literal with three parts', () => {
    expect(parseAcl('group:billing:read')).toEqual({
      resource_type: 'group', name: 'billing', pattern: 'literal', operations: ['read'],
    });
  });

  it('keeps colons in the name', () => {
    expect(parseAcl('group:app:consumer:read')).toEqual({
      resource_type: 'group', name: 'app:consumer', pattern: 'literal', operations: ['read'],
    });
    expect(parseAcl('group:app:consumer:prefix:read')).toEqual({
      resource_type: 'group', name: 'app:consumer', pattern: 'prefix', operations: ['read'],
    });
    expect(parseAcl('topic:a:b:c:literal:write')).toMatchObject({ name: 'a:b:c', pattern: 'literal', operations: ['write'] });
  });

  it('parses a cluster rule without name or pattern', () => {
    expect(parseAcl('cluster:describe')).toEqual({ resource_type: 'cluster', operations: ['describe'] });
  });

  it('accepts * as a literal name and normalises case and duplicates', () => {
    expect(parseAcl('Topic:*:literal:READ,read')).toMatchObject({ name: '*', operations: ['read'] });
  });

  it.each([
    ['queue:x:read', /unknown resource/],
    ['topic:orders:prefix:fly', /fly not allowed on topic/],
    ['group:g:literal:write', /write not allowed on group/],
    ['cluster:read', /read not allowed on cluster/],
    ['cluster:orders:describe', /only operations/],
    ['topic:*:prefix:read', /only valid with the literal/],
    ['topic::literal:read', /name is empty/],
    ['topic:orders:literal:', /no operations/],
    ['topic', /wrong number of parts/],
  ])('rejects %s', (spec, message) => {
    expect(() => parseAcl(spec)).toThrow(UsageError);
    expect(() => parseAcl(spec)).toThrow(message);
  });

  it('round-trips through formatAcl', () => {
    for (const spec of ['topic:orders.:prefix:read,describe', 'cluster:describe']) {
      expect(formatAcl(parseAcl(spec))).toBe(spec);
    }
  });
});

describe('queue users', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  const out = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const m of [mockGet, mockPost, mockPut, mockDelete, mockGetText, confirmMock]) m.mockReset();
    setJsonMode(false);
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setJsonMode(false);
  });

  it('lists users with their rules', async () => {
    routeGet({ [`${Q}/kafka-users`]: { data: [user()], meta: {} } });

    await run(['users', 'ev']);

    expect(out()).toContain('kafka-ev.orders-app');
    expect(out()).toContain('topic:orders.:prefix:read,describe');
  });

  it('lists with the explicit ls subcommand too, and as JSON', async () => {
    setJsonMode(true);
    routeGet({ [`${Q}/kafka-users`]: { data: [user()], meta: { max_users: 10, max_acl_rules: 50, max_name_length: 20 } } });

    await run(['users', 'ls', 'ev']);

    const json = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(json.data[0].name).toBe('orders-app');
    expect(json.meta).toEqual({ count: 1, max_users: 10, max_acl_rules: 50, max_name_length: 20 });
  });

  it('creates a user, sends parsed rules and prints the password once with a warning', async () => {
    routeGet({});
    mockPost.mockResolvedValueOnce({ data: user({ password: 's3cret' }) });

    await run(['users', 'create', 'ev', 'orders-app', '--acl', 'topic:orders.:prefix:read,describe', '--acl', 'cluster:describe']);

    expect(mockPost).toHaveBeenCalledWith(`${Q}/kafka-users`, {
      name: 'orders-app',
      acls: [
        { resource_type: 'topic', name: 'orders.', pattern: 'prefix', operations: ['read', 'describe'] },
        { resource_type: 'cluster', operations: ['describe'] },
      ],
    });
    expect(out()).toContain('s3cret');
    expect(out()).toMatch(/only this once/);
  });

  it('includes the password in --json output', async () => {
    setJsonMode(true);
    routeGet({});
    mockPost.mockResolvedValueOnce({ data: user({ password: 's3cret' }) });

    await run(['users', 'create', 'ev', 'orders-app', '--acl', 'cluster:describe']);

    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0])).data.password).toBe('s3cret');
  });

  it('refuses a malformed --acl before any request', async () => {
    await expect(run(['users', 'create', 'ev', 'x', '--acl', 'topic:orders:fly'])).rejects.toThrow(UsageError);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('replaces the rules on update, resolving the user by name', async () => {
    routeGet({ [`${Q}/kafka-users`]: { data: [user()] } });
    mockPut.mockResolvedValueOnce({ data: user({ acls: [] }) });

    await run(['users', 'update', 'ev', 'orders-app', '--acl', 'group:billing:literal:read']);

    expect(mockPut).toHaveBeenCalledWith(`${Q}/kafka-users/u-1`, {
      acls: [{ resource_type: 'group', name: 'billing', pattern: 'literal', operations: ['read'] }],
    });
  });

  it('update needs --acl or --none, and --none sends an empty list', async () => {
    await expect(run(['users', 'update', 'ev', 'orders-app'])).rejects.toThrow(/--none/);
    expect(mockPut).not.toHaveBeenCalled();

    routeGet({ [`${Q}/kafka-users`]: { data: [user()] } });
    mockPut.mockResolvedValueOnce({ data: user({ acls: [] }) });
    await run(['users', 'update', 'ev', 'orders-app', '--none']);
    expect(mockPut).toHaveBeenCalledWith(`${Q}/kafka-users/u-1`, { acls: [] });
  });

  it('reports an unknown user', async () => {
    routeGet({ [`${Q}/kafka-users`]: { data: [user()] } });

    await expect(run(['users', 'rm', 'ev', 'ghost', '--yes'])).rejects.toThrow(/'ghost' not found/);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('deletes with --yes and refuses without confirmation when non-interactive', async () => {
    routeGet({ [`${Q}/kafka-users`]: { data: [user()] } });
    mockDelete.mockResolvedValue({ message: 'Kafka user deletion initiated.' });

    await expect(run(['users', 'rm', 'ev', 'orders-app'])).rejects.toThrow(ConfirmationRequiredError);
    expect(mockDelete).not.toHaveBeenCalled();

    await run(['users', 'rm', 'ev', 'orders-app', '--yes']);
    expect(mockDelete).toHaveBeenCalledWith(`${Q}/kafka-users/u-1`);
  });

  it('looks the queue up by exact name for changes but not for the list', async () => {
    routeGet({ [`${Q}/kafka-users`]: { data: [user()] } });
    mockPost.mockResolvedValue({ data: user() });
    // an id prefix ("q-") must not select the queue for a credential change
    mockGet.mockImplementation((path: string) =>
      path.startsWith('/api/v1/queue?')
        ? Promise.resolve({ data: [{ id: 'q-1', name: 'ev', provider: 'kafka' }], pagination: { last_page: 1, total: 1 } })
        : Promise.resolve({ data: [user()] }),
    );

    await expect(run(['users', 'rotate-password', 'q-', 'orders-app', '--yes'])).rejects.toThrow(/not found/);
    expect(mockPost).not.toHaveBeenCalled();
    await run(['users', 'ls', 'q-']);
    expect(out()).toContain('orders-app');
  });

  it('rotate-password without --yes when non-interactive exits 5 and sends nothing', async () => {
    routeGet({ [`${Q}/kafka-users`]: { data: [user()] } });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);

    const failure = await run(['users', 'rotate-password', 'ev', 'orders-app']).catch((e) => e);

    expect(failure).toBeInstanceOf(ConfirmationRequiredError);
    expect(() => handleError(failure)).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(5);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('refuses --acl together with --none before any request', async () => {
    await expect(run(['users', 'update', 'ev', 'orders-app', '--acl', 'cluster:describe', '--none'])).rejects.toThrow(/either --acl or --none/);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('shows the API 422 on a RabbitMQ queue', async () => {
    routeGet({});
    mockPost.mockRejectedValueOnce(new ApiError(422, 'Users and ACLs are available for Kafka clusters only.'));

    await expect(run(['users', 'create', 'ev', 'orders-app', '--acl', 'cluster:describe'])).rejects.toMatchObject({
      statusCode: 422,
      message: 'Users and ACLs are available for Kafka clusters only.',
    });
  });

  it('sends a group name containing colons intact', async () => {
    routeGet({});
    mockPost.mockResolvedValueOnce({ data: user() });

    await run(['users', 'create', 'ev', 'orders-app', '--acl', 'group:app:consumer:prefix:read']);

    expect(mockPost.mock.calls[0]?.[1].acls).toEqual([
      { resource_type: 'group', name: 'app:consumer', pattern: 'prefix', operations: ['read'] },
    ]);
  });

  it('rotates a password after confirmation and shows the new one once', async () => {
    routeGet({ [`${Q}/kafka-users`]: { data: [user()] } });
    mockPost.mockResolvedValueOnce({ data: user({ status: 'pending', password: 'n3w' }) });

    await run(['users', 'rotate-password', 'ev', 'orders-app', '--yes']);

    expect(mockPost).toHaveBeenCalledWith(`${Q}/kafka-users/u-1/rotate-password`);
    expect(out()).toContain('n3w');
    expect(out()).toMatch(/only this once/);
    expect(out()).toContain('pending');
    expect(out()).toMatch(/old password keeps working/);
  });
});

describe('queue schema-registry', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  const out = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const m of [mockGet, mockPost, mockPut, mockDelete, mockGetText, confirmMock]) m.mockReset();
    setJsonMode(false);
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setJsonMode(false);
  });

  it('shows a ready registry with url, username and password', async () => {
    routeGet({ [`${Q}/schema-registry`]: { data: registry({ enabled: true, status: 'ready', url: 'https://sr.example', password: 'pw' }) } });

    await run(['schema-registry', 'ev']);

    expect(out()).toContain('https://sr.example');
    expect(out()).toContain('registry');
    expect(out()).toContain('pw');
  });

  it('says the password is hidden when the API withholds it', async () => {
    routeGet({ [`${Q}/schema-registry`]: { data: registry({ enabled: true, status: 'ready', url: 'https://sr.example' }) } });

    await run(['schema-registry', 'show', 'ev']);

    expect(out()).toMatch(/hidden/);
  });

  it('enable needs --yes non-interactively and names the price', async () => {
    routeGet({ [`${Q}/schema-registry`]: { data: registry() } });
    mockPost.mockResolvedValueOnce({ data: registry({ enabled: true, status: 'provisioning' }) });

    await expect(run(['schema-registry', 'enable', 'ev'])).rejects.toThrow(ConfirmationRequiredError);
    expect(mockPost).not.toHaveBeenCalled();

    await run(['schema-registry', 'enable', 'ev', '--yes']);
    expect(mockPost).toHaveBeenCalledWith(`${Q}/schema-registry`);
    expect(out()).toContain('EUR 4.99/month');
  });

  it('enable asks interactively with the price in the question', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    routeGet({ [`${Q}/schema-registry`]: { data: registry() } });
    confirmMock.mockResolvedValueOnce(false);

    await run(['schema-registry', 'enable', 'ev']);

    expect(confirmMock.mock.calls[0]?.[0].message).toContain('EUR 4.99/month');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('enable does nothing when already enabled', async () => {
    routeGet({ [`${Q}/schema-registry`]: { data: registry({ enabled: true, status: 'ready' }) } });

    await run(['schema-registry', 'enable', 'ev', '--yes']);

    expect(mockPost).not.toHaveBeenCalled();
    expect(out()).toMatch(/already enabled/);
  });

  it('disable warns that schemas stay in the cluster; enable accepts --force', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    routeGet({ [`${Q}/schema-registry`]: { data: registry() } });
    confirmMock.mockResolvedValueOnce(false);

    await run(['schema-registry', 'disable', 'ev']);

    const message = confirmMock.mock.calls[0]?.[0].message as string;
    expect(message).toMatch(/_schemas topic/);
    expect(message).toMatch(/billing stops/);
    expect(mockDelete).not.toHaveBeenCalled();

    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    mockPost.mockResolvedValueOnce({ data: registry({ enabled: true, status: 'provisioning' }) });
    await run(['schema-registry', 'enable', 'ev', '--force']);
    expect(mockPost).toHaveBeenCalledWith(`${Q}/schema-registry`);
  });

  it('disable and rotate-password without --yes when non-interactive exit 5 and send nothing', async () => {
    routeGet({});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);

    for (const verb of ['disable', 'rotate-password']) {
      const failure = await run(['schema-registry', verb, 'ev']).catch((e) => e);
      expect(failure).toBeInstanceOf(ConfirmationRequiredError);
      expect(() => handleError(failure)).toThrow('exit');
      expect(exit).toHaveBeenLastCalledWith(5);
    }
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('shows the API 422 on a RabbitMQ queue', async () => {
    routeGet({ [`${Q}/schema-registry`]: { data: registry() } });
    mockPost.mockRejectedValueOnce(new ApiError(422, 'Schema Registry is available for Kafka clusters only.'));

    await expect(run(['schema-registry', 'enable', 'ev', '--yes'])).rejects.toMatchObject({ statusCode: 422 });
  });

  it('disables with --yes', async () => {
    routeGet({});
    mockDelete.mockResolvedValueOnce({});

    await run(['schema-registry', 'disable', 'ev', '--yes']);

    expect(mockDelete).toHaveBeenCalledWith(`${Q}/schema-registry`);
  });

  it('rotates the password with --yes and prints the new one', async () => {
    routeGet({});
    mockPost.mockResolvedValueOnce({ data: registry({ enabled: true, status: 'ready', url: 'https://sr.example', password: 'n3w' }) });

    await run(['schema-registry', 'rotate-password', 'ev', '--yes']);

    expect(mockPost).toHaveBeenCalledWith(`${Q}/schema-registry/rotate-password`);
    expect(out()).toContain('n3w');
  });
});

describe('queue connection-info schema_registry block', () => {
  it('shows the registry when present', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setJsonMode(false);
    mockGet.mockReset();
    routeGet({
      [`${Q}/connection-info`]: {
        provider: 'kafka', status: 'ready', bootstrap_servers: 'h:29092', username: 'u', password: 'p',
        schema_registry: { status: 'ready', url: 'https://sr.example', username: 'registry', password: 'srpw' },
      },
    });

    await run(['connection-info', 'ev']);

    const text = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('Schema Registry');
    expect(text).toContain('https://sr.example');
    expect(text).toContain('srpw');
    logSpy.mockRestore();
  });
});

describe('queue client-properties', () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const body = 'bootstrap.servers=h:29092\nsasl.jaas.config=...password="x";\n';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kafka-props-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGet.mockReset();
    mockGetText.mockReset();
    routeGet({});
    mockGetText.mockResolvedValue(body);
    setJsonMode(false);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the file with mode 600 and does not print the contents', async () => {
    const file = join(dir, 'out.properties');

    await run(['client-properties', 'ev', '-o', file]);

    expect(mockGetText).toHaveBeenCalledWith(`${Q}/client-properties`);
    expect(await readFile(file, 'utf8')).toBe(body);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('bootstrap.servers');
  });

  it('refuses to overwrite without --force, and tightens the mode with it', async () => {
    const file = join(dir, 'out.properties');
    await writeFile(file, 'old', { mode: 0o644 });
    await chmod(file, 0o644);

    await expect(run(['client-properties', 'ev', '-o', file])).rejects.toThrow(/already exists/);
    expect(await readFile(file, 'utf8')).toBe('old');

    await run(['client-properties', 'ev', '-o', file, '--force']);
    expect(await readFile(file, 'utf8')).toBe(body);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('writes nothing when the API answers 422 (RabbitMQ queue)', async () => {
    mockGetText.mockRejectedValueOnce(new ApiError(422, 'Client properties are available for Kafka clusters only.'));
    const file = join(dir, 'never.properties');

    await expect(run(['client-properties', 'ev', '-o', file])).rejects.toMatchObject({ statusCode: 422 });
    await expect(lstat(file)).rejects.toThrow();
  });

  it('errors clearly when -o is a directory', async () => {
    await expect(run(['client-properties', 'ev', '-o', dir])).rejects.toThrow(/is a directory/);
    await expect(run(['client-properties', 'ev', '-o', dir, '--force'])).rejects.toThrow(/is a directory/);
  });

  it('with --force replaces a symlink instead of writing through it', async () => {
    const target = join(dir, 'target.txt');
    const link = join(dir, 'link.properties');
    await writeFile(target, 'precious');
    await symlink(target, link);

    await run(['client-properties', 'ev', '-o', link, '--force']);

    expect(await readFile(target, 'utf8')).toBe('precious');
    expect((await lstat(link)).isSymbolicLink()).toBe(false);
    expect(await readFile(link, 'utf8')).toBe(body);
    expect((await stat(link)).mode & 0o777).toBe(0o600);
  });

  it('refuses to follow a symlink without --force too', async () => {
    const target = join(dir, 'target.txt');
    const link = join(dir, 'link.properties');
    await writeFile(target, 'precious');
    await symlink(target, link);

    await expect(run(['client-properties', 'ev', '-o', link])).rejects.toThrow(/already exists/);
    expect(await readFile(target, 'utf8')).toBe('precious');
  });

  it('prints to stdout only for -o -', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await run(['client-properties', 'ev', '-o', '-']);

    expect(write).toHaveBeenCalledWith(body);
  });
});
