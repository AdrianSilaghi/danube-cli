import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { DockerDeps, HelperResult } from '../src/lib/docker-credentials.js';

const spawnMock = vi.fn();
const readFileMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));
vi.mock('node:fs/promises', () => ({ readFile: (...args: unknown[]) => readFileMock(...args) }));

const { checkDockerPush, readDockerCredential, parseImageReference } = await import('../src/lib/docker-credentials.js');

beforeEach(() => {
  spawnMock.mockReset();
  readFileMock.mockReset();
});

const HOST = 'cr.danubedata.ro';
const REPO = 'ns/app';
const basic = (user: string, secret: string): string => Buffer.from(`${user}:${secret}`).toString('base64');
const jwt = (payload: unknown): string =>
  `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
const access = (actions: string[], name = REPO) => jwt({ access: [{ type: 'repository', name, actions }] });

const ENOENT = Object.assign(new Error('no such file'), { code: 'ENOENT' });

const challenge = (realm = 'https://auth.danubedata.ro/token', service = 'registry'): Response =>
  new Response('', { status: 401, headers: { 'www-authenticate': `Bearer realm="${realm}",service="${service}"` } });
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

interface Setup {
  config?: unknown | null;
  helper?: HelperResult | Error;
  responses?: Response[];
}

/** Deps whose file, credential helper and network are scripted; `fetch` records its calls. */
function deps({ config, helper, responses = [] }: Setup): { deps: DockerDeps; fetch: ReturnType<typeof vi.fn>; runHelper: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn();
  for (const r of responses) fetch.mockResolvedValueOnce(r);
  const runHelper = vi.fn().mockImplementation(async () => {
    if (helper instanceof Error) throw helper;
    return helper;
  });
  return {
    fetch,
    runHelper,
    deps: {
      readFile: async () => {
        if (config === null || config === undefined) throw ENOENT;
        return typeof config === 'string' ? config : JSON.stringify(config);
      },
      runHelper,
      fetch: fetch as unknown as typeof globalThis.fetch,
      env: {},
      home: '/home/u',
    },
  };
}

const withAuth = { auths: { [HOST]: { auth: basic('dd-key', 's3cret') } } };

describe('readDockerCredential', () => {
  it('reads auths[host].auth, matching host, https://host and https://host/v1/', async () => {
    for (const key of [HOST, `https://${HOST}`, `https://${HOST}/v1/`]) {
      const { deps: d } = deps({ config: { auths: { [key]: { auth: basic('u', 'p:with:colons') } } } });
      expect(await readDockerCredential(HOST, d)).toEqual({ username: 'u', secret: 'p:with:colons' });
    }
  });

  it('is null without a config file, a matching entry or a decodable auth', async () => {
    expect(await readDockerCredential(HOST, deps({ config: null }).deps)).toBeNull();
    expect(await readDockerCredential(HOST, deps({ config: { auths: { 'other.io': { auth: basic('u', 'p') } } } }).deps)).toBeNull();
    expect(await readDockerCredential(HOST, deps({ config: { auths: { [HOST]: {} } } }).deps)).toBeNull();
    expect(await readDockerCredential(HOST, deps({ config: { auths: { [HOST]: { auth: Buffer.from('nocolon').toString('base64') } } } }).deps)).toBeNull();
    expect(await readDockerCredential(HOST, deps({ config: {} }).deps)).toBeNull();
  });

  it('prefers credHelpers[host] over credsStore and sends the host on the helper input', async () => {
    const { deps: d, runHelper } = deps({
      config: { credHelpers: { [HOST]: 'pass' }, credsStore: 'osxkeychain', auths: withAuth.auths },
      helper: { code: 0, stdout: JSON.stringify({ Username: 'hu', Secret: 'hs' }), stderr: '' },
    });

    expect(await readDockerCredential(HOST, d)).toEqual({ username: 'hu', secret: 'hs' });
    expect(runHelper).toHaveBeenCalledWith('pass', HOST);
  });

  it('uses credsStore when no per-registry helper is set', async () => {
    const { deps: d, runHelper } = deps({
      config: { credsStore: 'desktop' },
      helper: { code: 0, stdout: JSON.stringify({ Username: 'hu', Secret: 'hs' }), stderr: '' },
    });

    await readDockerCredential(HOST, d);
    expect(runHelper).toHaveBeenCalledWith('desktop', HOST);
  });

  it('uses only the configured store: a login it does not hold is no login, whatever auths still says', async () => {
    const store = deps({ config: { credsStore: 'desktop', ...withAuth }, helper: { code: 1, stdout: 'credentials not found in native keychain\n', stderr: '' } });
    expect(await readDockerCredential(HOST, store.deps)).toBeNull();

    const perHost = deps({ config: { credHelpers: { [HOST]: 'pass' }, ...withAuth }, helper: { code: 1, stdout: '', stderr: 'credentials not found' } });
    expect(await readDockerCredential(HOST, perHost.deps)).toBeNull();

    const noUser = deps({ config: { credsStore: 'desktop' }, helper: { code: 0, stdout: JSON.stringify({ Secret: 'hs' }), stderr: '' } });
    expect(await readDockerCredential(HOST, noUser.deps)).toEqual({ username: '', secret: 'hs' });

    const blankSecret = deps({ config: { credsStore: 'desktop' }, helper: { code: 0, stdout: JSON.stringify({ Username: 'u', Secret: '' }), stderr: '' } });
    expect(await readDockerCredential(HOST, blankSecret.deps)).toBeNull();
  });

  it('honours DOCKER_CONFIG over the home directory', async () => {
    const seen: string[] = [];
    const { deps: d } = deps({ config: {} });
    await readDockerCredential(HOST, { ...d, env: { DOCKER_CONFIG: '/custom' }, readFile: async (p) => { seen.push(p); return '{}'; } });
    await readDockerCredential(HOST, { ...d, readFile: async (p) => { seen.push(p); return '{}'; } });

    expect(seen).toEqual(['/custom/config.json', '/home/u/.docker/config.json']);
  });

  it.each([
    ['an unreadable config', { readFile: async () => { throw new Error('EACCES'); } }, /could not read .*config\.json: EACCES/],
    ['a config that is not JSON', {}, /is not valid JSON/],
  ])('says it could not decide for %s', async (_name, override, message) => {
    const { deps: d } = deps({ config: '{nope' });
    await expect(readDockerCredential(HOST, { ...d, ...override })).rejects.toThrow(message);
  });

  it.each([
    ['a helper name that is not a name', { code: 0, stdout: '', stderr: '' }, '../evil', /not valid/],
    ['a helper that fails', { code: 2, stdout: '', stderr: 'boom' }, 'pass', /docker-credential-pass failed \(exit 2\)/],
    ['a helper that does not answer JSON', { code: 0, stdout: 'hello', stderr: '' }, 'pass', /did not answer with JSON/],
    ['a helper that cannot be started', new Error('spawn ENOENT'), 'pass', /could not be run: spawn ENOENT/],
  ])('says it could not decide for %s', async (_name, helper, name, message) => {
    const { deps: d } = deps({ config: { credsStore: name }, helper: helper as HelperResult | Error });
    await expect(readDockerCredential(HOST, d)).rejects.toThrow(message);
  });
});

describe('checkDockerPush', () => {
  it('reports no login, without touching the network', async () => {
    const { deps: d, fetch } = deps({ config: {} });

    const check = await checkDockerPush(HOST, REPO, d);

    expect(check).toMatchObject({ status: 'no_credentials', can_push: false, actions: [] });
    expect(check.message).toBe(`Docker has no login for ${HOST}: run danube registry login`);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('asks the realm the registry names, with Basic auth and a push,pull scope, and reports a push grant', async () => {
    const { deps: d, fetch } = deps({ config: withAuth, responses: [challenge(), json({ token: access(['pull', 'push']) })] });

    const check = await checkDockerPush(HOST, REPO, d);

    expect(check).toMatchObject({ status: 'push', can_push: true, actions: ['pull', 'push'], registry_host: HOST, repository: REPO });
    expect(fetch.mock.calls[0]![0]).toBe(`https://${HOST}/v2/`);
    const [url, init] = fetch.mock.calls[1]! as [URL, RequestInit];
    expect(url.origin + url.pathname).toBe('https://auth.danubedata.ro/token');
    expect(url.searchParams.get('service')).toBe('registry');
    expect(url.searchParams.get('scope')).toBe(`repository:${REPO}:push,pull`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${basic('dd-key', 's3cret')}`);
    expect(init.redirect).toBe('error');
  });

  it('never returns the secret or the token', async () => {
    const token = access(['pull', 'push']);
    const { deps: d } = deps({ config: withAuth, responses: [challenge(), json({ token })] });

    const text = JSON.stringify(await checkDockerPush(HOST, REPO, d));

    expect(text).not.toContain('s3cret');
    expect(text).not.toContain(token);
  });

  it('accepts access_token, a wildcard grant and a realm without a service', async () => {
    const { deps: d, fetch } = deps({ config: withAuth, responses: [challenge('https://auth.example/t', ''), json({ access_token: access(['*']) })] });

    expect((await checkDockerPush(HOST, REPO, d)).status).toBe('push');
    expect((fetch.mock.calls[1]![0] as URL).searchParams.has('service')).toBe(false);
  });

  it('reports a pull-only key', async () => {
    const { deps: d } = deps({ config: withAuth, responses: [challenge(), json({ token: access(['pull']) })] });

    const check = await checkDockerPush(HOST, REPO, d);

    expect(check).toMatchObject({ status: 'pull_only', can_push: false, actions: ['pull'] });
    expect(check.message).toContain('can only pull');
    expect(check.message).toContain('danube registry login');
  });

  it('reports a login with no access to the repository, including a grant for another one', async () => {
    const empty = deps({ config: withAuth, responses: [challenge(), json({ token: jwt({ access: [] }) })] });
    expect(await checkDockerPush(HOST, REPO, empty.deps)).toMatchObject({ status: 'no_access', can_push: false });

    const other = deps({ config: withAuth, responses: [challenge(), json({ token: access(['push'], 'other/app') })] });
    expect((await checkDockerPush(HOST, REPO, other.deps)).status).toBe('no_access');

    const noActions = deps({ config: withAuth, responses: [challenge(), json({ token: jwt({ access: [{ type: 'repository', name: REPO }] }) })] });
    expect((await checkDockerPush(HOST, REPO, noActions.deps)).status).toBe('no_access');
  });

  it('reports a 401 as a login the registry does not accept, with the realm\'s own reason', async () => {
    const { deps: d } = deps({ config: withAuth, responses: [challenge(), json({ errors: [{ code: 'UNAUTHORIZED', message: 'key revoked' }] }, 401)] });

    const check = await checkDockerPush(HOST, REPO, d);

    expect(check).toMatchObject({ status: 'rejected', can_push: false });
    expect(check.message).toContain('(HTTP 401): key revoked');
    expect(check.message).toContain('may be revoked or expired');
  });

  it('reports a 403 with the realm\'s own reason and does not blame the key', async () => {
    const { deps: d } = deps({ config: withAuth, responses: [challenge(), json({ errors: [{ code: 'DENIED', message: 'storage quota exceeded' }] }, 403)] });

    const check = await checkDockerPush(HOST, REPO, d);

    expect(check).toMatchObject({ status: 'rejected', can_push: false });
    expect(check.message).toBe(`${HOST} refused the token request (HTTP 403): storage quota exceeded`);
  });

  it.each([
    ['a body that is not JSON', new Response('nope', { status: 403 })],
    ['an error list without a message', json({ errors: [{}] }, 403)],
    ['a blank message', json({ errors: [{ message: '  ' }] }, 403)],
  ])('reports a 403 without a reason for %s', async (_name, body) => {
    const { deps: d } = deps({ config: withAuth, responses: [challenge(), body] });

    expect((await checkDockerPush(HOST, REPO, d)).message).toBe(`${HOST} refused the token request (HTTP 403)`);
  });

  it('cuts a very long reason', async () => {
    const { deps: d } = deps({ config: withAuth, responses: [challenge(), json({ errors: [{ message: 'x'.repeat(500) }] }, 403)] });

    expect((await checkDockerPush(HOST, REPO, d)).message.length).toBeLessThan(300);
  });

  it('refuses to send the login to a plain-http realm', async () => {
    const { deps: d, fetch } = deps({ config: withAuth, responses: [challenge('http://auth.example/token')] });

    const check = await checkDockerPush(HOST, REPO, d);

    expect(check).toMatchObject({ status: 'unknown', can_push: null });
    expect(check.message).toContain('is not https');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a registry that does not challenge', [new Response('{}', { status: 200 })], /did not offer a Bearer token realm \(GET \/v2\/ answered 200\)/],
    ['a Basic challenge', [new Response('', { status: 401, headers: { 'www-authenticate': 'Basic realm="r"' } })], /did not offer a Bearer/],
    ['a challenge without a realm', [new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer service="s"' } })], /did not offer a Bearer/],
    ['a 401 without a header', [new Response('', { status: 401 })], /did not offer a Bearer/],
    ['a token server error', [challenge(), json({}, 500)], /token realm answered 500/],
    ['a token response without a token', [challenge(), new Response('not json', { status: 200 })], /answered without a token/],
    ['a token that is not a JWT', [challenge(), json({ token: 'opaque' })], /no readable access claim/],
    ['a JWT without an access claim', [challenge(), json({ token: jwt({ sub: 'x' }) })], /no readable access claim/],
  ])('says it could not decide for %s', async (_name, responses, message) => {
    const { deps: d } = deps({ config: withAuth, responses: responses as Response[] });

    const check = await checkDockerPush(HOST, REPO, d);

    expect(check).toMatchObject({ status: 'unknown', can_push: null, actions: [] });
    expect(check.message).toMatch(message);
  });

  it('says it could not decide when the network fails, and still reports the host', async () => {
    const { deps: d, fetch } = deps({ config: withAuth });
    fetch.mockRejectedValue(new TypeError('fetch failed'));

    const check = await checkDockerPush(HOST, REPO, d);

    expect(check.status).toBe('unknown');
    expect(check.message).toContain(`${HOST} could not be reached (fetch failed)`);
  });

  it('does not present an identity token as a password', async () => {
    const { deps: d, fetch } = deps({ config: { auths: { [HOST]: { auth: basic('<token>', 'refresh') } } } });

    const check = await checkDockerPush(HOST, REPO, d);

    expect(check.status).toBe('unknown');
    expect(check.message).toContain('identity token');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads the real config file and credential helper by default', async () => {
    readFileMock.mockResolvedValueOnce(JSON.stringify({ credsStore: 'pass' }));
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
    spawnMock.mockReturnValueOnce(child);
    const stdinSeen: string[] = [];
    child.stdin.on('data', (c: Buffer) => stdinSeen.push(String(c)));
    const fetchStub = vi.fn().mockResolvedValueOnce(challenge()).mockResolvedValueOnce(json({ token: access(['push']) }));
    vi.stubGlobal('fetch', fetchStub);

    const pending = checkDockerPush(HOST, REPO);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stdout.write(JSON.stringify({ Username: 'hu', Secret: 'hs' }));
    child.emit('close', 0);

    expect((await pending).status).toBe('push');
    expect(spawnMock).toHaveBeenCalledWith('docker-credential-pass', ['get'], expect.any(Object));
    expect(stdinSeen.join('')).toBe(HOST);
    vi.unstubAllGlobals();
  });

  it('stops a credential helper that does not answer in time, and ignores a closed input', async () => {
    vi.useFakeTimers();
    try {
      readFileMock.mockResolvedValueOnce(JSON.stringify({ credsStore: 'pass' }));
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
      spawnMock.mockReturnValueOnce(child);

      const pending = checkDockerPush(HOST, REPO);
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
      child.stdin.emit('error', new Error('EPIPE'));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(child.kill).toHaveBeenCalled();
      child.emit('close', null);

      expect((await pending).message).toContain('failed (exit null)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a helper process that fails to start as undetermined', async () => {
    readFileMock.mockResolvedValueOnce(JSON.stringify({ credsStore: 'pass' }));
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
    spawnMock.mockReturnValueOnce(child);

    const pending = checkDockerPush(HOST, REPO);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stderr.write('warn');
    child.emit('error', new Error('spawn docker-credential-pass ENOENT'));

    expect((await pending).message).toContain('could not be run');
  });
});

describe('parseImageReference', () => {
  it.each([
    ['cr.danubedata.ro/ns/app:v1', { host: 'cr.danubedata.ro', repository: 'ns/app' }],
    ['cr.danubedata.ro/ns/app@sha256:abc', { host: 'cr.danubedata.ro', repository: 'ns/app' }],
    ['cr.danubedata.ro/ns/app', { host: 'cr.danubedata.ro', repository: 'ns/app' }],
    ['localhost:5000/app:1', { host: 'localhost:5000', repository: 'app' }],
    ['localhost/app', { host: 'localhost', repository: 'app' }],
    ['ns/app:latest', { host: null, repository: 'ns/app' }],
    ['app', { host: null, repository: 'app' }],
  ])('%s', (reference, expected) => {
    expect(parseImageReference(reference)).toEqual(expected);
  });
});
