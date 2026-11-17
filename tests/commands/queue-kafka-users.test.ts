import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, stat, writeFile, chmod, rm, symlink, lstat, readdir, mkdir } from 'node:fs/promises';
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

// Pass-through fs wrappers so a test can make the write or the rename fail (FAT-style failures).
const fsFaults = { writePartialThenFail: false, renameFails: false, writtenPaths: [] as string[] };
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      fsFaults.writtenPaths.push(String(args[0]));
      await actual.writeFile(...args);
      if (fsFaults.writePartialThenFail) throw new Error('ENOSPC: disk full');
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fsFaults.renameFails) throw new Error('EXDEV: cannot rename');
      return actual.rename(...args);
    },
  };
});

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
    expect(parseAcl('transactional_id:a:b:c:literal:write')).toMatchObject({ name: 'a:b:c', pattern: 'literal', operations: ['write'] });
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
    ['topic::literal:read', /empty name or segment/],
    ['topic:orders::read', /empty name or segment/],
    ['group::a:read', /empty name or segment/],
    ['group:a::read', /empty name or segment/],
    ['topic:orders:prefx:read', /unknown pattern "prefx" \(literal or prefix\)/],
    ['topic:a:b:prefix:read', /topic name cannot contain ":" \(got "a:b"\)/],
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

  it('lists users as a table with one line per user', async () => {
    const two = user({
      id: 'u-2', name: 'audit', username: 'kafka-ev.audit', status: 'pending', created_at: null,
      acls: [
        { resource_type: 'topic', name: 'orders.', pattern: 'prefix', operations: ['read', 'describe'] },
        { resource_type: 'cluster', operations: ['describe'] },
      ],
    });
    routeGet({ [`${Q}/kafka-users`]: { data: [user({ created_at: null }), two], meta: {} } });

    await run(['users', 'ev']);

    expect(out().split('\n')).toEqual([
      'NAME        USERNAME             STATUS   ACLS                                                  CREATED',
      '----------  -------------------  -------  ----------------------------------------------------  -------',
      'orders-app  kafka-ev.orders-app  active   topic:orders.:prefix:read,describe                    -      ',
      'audit       kafka-ev.audit       pending  topic:orders.:prefix:read,describe; cluster:describe  -      ',
    ]);
  });

  it('prints the status message of a user the cluster refused, under the table', async () => {
    routeGet({
      [`${Q}/kafka-users`]: {
        data: [user({ created_at: null, status: 'error', status_message: 'ACL rejected by the cluster' })],
        meta: {},
      },
    });

    await run(['users', 'ls', 'ev']);

    const lines = out().split('\n');
    expect(lines[lines.length - 1]).toBe('orders-app: ACL rejected by the cluster');
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
    expect(out()).toMatch(/applies it in the background.*pending/);
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
    expect(out()).toMatch(/applies the new rules in the background.*pending/);
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

  it('lists users when the queue is given as an id prefix (read-only lookup)', async () => {
    mockGet.mockImplementation((path: string) =>
      path.startsWith('/api/v1/queue?') ? Promise.resolve(queueList) : Promise.resolve({ data: [user()] }),
    );

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

  it('the rotate confirmation says the old password keeps working and connections close within an hour', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    routeGet({ [`${Q}/kafka-users`]: { data: [user()] } });
    confirmMock.mockResolvedValueOnce(false);

    await run(['users', 'rotate-password', 'ev', 'orders-app']);

    const message = confirmMock.mock.calls[0]?.[0].message as string;
    expect(message).toMatch(/old password keeps working until the cluster applies the new one/);
    expect(message).toMatch(/within an hour/);
    expect(message).not.toMatch(/disconnected/);
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
    routeGet({ [`${Q}/schema-registry`]: { data: registry({ enabled: true, status: 'ready' }) } });
    confirmMock.mockResolvedValueOnce(false);

    await run(['schema-registry', 'disable', 'ev']);

    const message = confirmMock.mock.calls[0]?.[0].message as string;
    expect(message).toMatch(/_schemas topic/);
    expect(message).toMatch(/billing stops/);
    expect(mockDelete).not.toHaveBeenCalled();

    routeGet({ [`${Q}/schema-registry`]: { data: registry() } });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    mockPost.mockResolvedValueOnce({ data: registry({ enabled: true, status: 'provisioning' }) });
    await run(['schema-registry', 'enable', 'ev', '--force']);
    expect(mockPost).toHaveBeenCalledWith(`${Q}/schema-registry`);
  });

  it('disable and rotate-password without --yes when non-interactive exit 5 and send nothing', async () => {
    routeGet({ [`${Q}/schema-registry`]: { data: registry({ enabled: true, status: 'ready' }) } });
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

  it('always sends the DELETE after confirmation, without reading the registry first', async () => {
    routeGet({});
    mockDelete.mockResolvedValue({});

    await run(['schema-registry', 'disable', 'ev', '--yes']);

    expect(mockDelete).toHaveBeenCalledWith(`${Q}/schema-registry`);
    expect(mockGet.mock.calls.some(([path]) => String(path).endsWith('/schema-registry'))).toBe(false);
    expect(out()).toContain("Schema Registry is being disabled on 'ev'; billing stops once it is removed.");
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
    Object.assign(fsFaults, { writePartialThenFail: false, renameFails: false, writtenPaths: [] });
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

  it('without --force writes straight to the target: no temp file, mode 600', async () => {
    const file = join(dir, 'out.properties');

    await run(['client-properties', 'ev', '-o', file]);

    expect(fsFaults.writtenPaths).toEqual([file]);
    expect(await readdir(dir)).toEqual(['out.properties']);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('with --force uses a short temp name and removes it when the rename fails', async () => {
    const file = join(dir, 'a-very-long-name-'.repeat(10) + '.properties');
    await writeFile(file, 'old');
    fsFaults.renameFails = true;

    await expect(run(['client-properties', 'ev', '-o', file, '--force'])).rejects.toThrow(/EXDEV/);

    expect(fsFaults.writtenPaths.filter((p) => p !== file).every((p) => /\/\.dd-[0-9a-f]{8}\.tmp$/.test(p))).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('old');
    expect(await readdir(dir)).toEqual([file.slice(dir.length + 1)]);
  });

  it('with --force removes the partial temp file when the write fails', async () => {
    const file = join(dir, 'out.properties');
    await writeFile(file, 'old');
    fsFaults.writePartialThenFail = true;

    await expect(run(['client-properties', 'ev', '-o', file, '--force'])).rejects.toThrow(/ENOSPC/);

    expect(await readFile(file, 'utf8')).toBe('old');
    expect(await readdir(dir)).toEqual(['out.properties']);
  });

  it.skipIf(process.getuid?.() === 0)('fails before the credential read when the directory is not writable', async () => {
    const locked = join(dir, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o500);

    try {
      await expect(run(['client-properties', 'ev', '-o', join(locked, 'x')])).rejects.toThrow(/not writable/);
      expect(mockGetText).not.toHaveBeenCalled();
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it('errors clearly when -o is a directory, before the credential read', async () => {
    await expect(run(['client-properties', 'ev', '-o', dir])).rejects.toThrow(/is a directory/);
    await expect(run(['client-properties', 'ev', '-o', dir, '--force'])).rejects.toThrow(/is a directory/);
    expect(mockGetText).not.toHaveBeenCalled();
  });

  it('validates the destination before the credential read', async () => {
    const existing = join(dir, 'there.properties');
    await writeFile(existing, 'old');

    await expect(run(['client-properties', 'ev', '-o', existing])).rejects.toThrow(/already exists/);
    await expect(run(['client-properties', 'ev', '-o', join(dir, 'no-such-dir', 'x')])).rejects.toThrow(/does not exist/);

    expect(mockGetText).not.toHaveBeenCalled();
    expect(await readFile(existing, 'utf8')).toBe('old');
  });

  it('leaves no temp file behind and keeps the old file when the credential read fails', async () => {
    const file = join(dir, 'out.properties');
    await writeFile(file, 'old');
    mockGetText.mockRejectedValueOnce(new ApiError(500, 'boom'));

    await expect(run(['client-properties', 'ev', '-o', file, '--force'])).rejects.toThrow('boom');
    expect(await readFile(file, 'utf8')).toBe('old');

    mockGetText.mockResolvedValueOnce(body);
    await run(['client-properties', 'ev', '-o', file, '--force']);
    expect(await readdir(dir)).toEqual(['out.properties']);
  });

  it('refuses -o - together with --json before the credential read', async () => {
    setJsonMode(true);

    await expect(run(['client-properties', 'ev', '-o', '-'])).rejects.toThrow(/not JSON/);
    expect(mockGetText).not.toHaveBeenCalled();
    setJsonMode(false);
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

describe('exact queue lookup', () => {
  // An id prefix ("q-" is the start of q-1) must never select a queue for these commands.
  const cases: [string, string[]][] = [
    ['queue rm', ['rm', 'q-', '--force']],
    ['queue update', ['update', 'q-', '--profile', 'kafka-medium']],
    ['queue start', ['start', 'q-']],
    ['queue stop', ['stop', 'q-']],
    ['queue connection-info', ['connection-info', 'q-']],
    ['users create', ['users', 'create', 'q-', 'u', '--acl', 'cluster:describe']],
    ['users update', ['users', 'update', 'q-', 'u', '--none']],
    ['users rotate-password', ['users', 'rotate-password', 'q-', 'u', '--yes']],
    ['users rm', ['users', 'rm', 'q-', 'u', '--yes']],
    ['schema-registry show', ['schema-registry', 'show', 'q-']],
    ['schema-registry enable', ['schema-registry', 'enable', 'q-', '--yes']],
    ['schema-registry disable', ['schema-registry', 'disable', 'q-', '--yes']],
    ['schema-registry rotate-password', ['schema-registry', 'rotate-password', 'q-', '--yes']],
    ['client-properties', ['client-properties', 'q-', '-o', '/nonexistent-dir/x']],
  ];

  beforeEach(() => {
    for (const m of [mockGet, mockPost, mockPut, mockDelete, mockGetText, confirmMock]) m.mockReset();
    setJsonMode(false);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it.each(cases)('%s refuses a prefix of the id', async (_label, args) => {
    mockGet.mockImplementation((path: string) =>
      path.startsWith('/api/v1/queue?') ? Promise.resolve(queueList) : Promise.reject(new Error(`unexpected GET ${path}`)),
    );

    await expect(run(args)).rejects.toThrow(/not found/);

    expect(mockGet).toHaveBeenCalledTimes(1);
    for (const m of [mockPost, mockPut, mockDelete, mockGetText]) expect(m).not.toHaveBeenCalled();
  });
});
