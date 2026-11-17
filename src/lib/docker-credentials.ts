import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * What Docker itself would present to a registry: the login `docker push` uses,
 * which is not the CLI's API token and not the project the push is aimed at.
 * `registry verify-push` answered "Push permitted" from the project alone and
 * `docker push` was then refused, because Docker's own credentials were missing
 * or pull-only.
 *
 * Nothing here ever prints or returns a secret: the Docker login goes to the
 * token realm the registry names, over https, and only its granted `access`
 * leaves this module.
 */

export interface HelperResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface DockerDeps {
  /** The file's text; rejects when it cannot be read (a missing config is `ENOENT`). */
  readFile: (path: string) => Promise<string>;
  /** `docker-credential-<helper> get` with `host` on its standard input. */
  runHelper: (helper: string, host: string) => Promise<HelperResult>;
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  home: string;
}

export type DockerPushStatus = 'push' | 'pull_only' | 'no_access' | 'no_credentials' | 'rejected' | 'unknown';

/** The verdict on Docker's credentials for one repository. `can_push` is null when it could not be determined. */
export interface DockerPushCheck {
  registry_host: string;
  repository: string;
  status: DockerPushStatus;
  can_push: boolean | null;
  /** The actions the registry granted on the repository, e.g. `["pull","push"]`. Empty when none was granted or the check could not run. */
  actions: string[];
  message: string;
}

interface Credential {
  username: string;
  secret: string;
}

/** The check could not run to a verdict; carries the reason for `status: unknown`. */
class Undetermined extends Error {}

const HELPER_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;
const HELPER_NAME = /^[A-Za-z0-9._-]+$/;
const HELPER_NOT_FOUND = /not found/i;
/** Docker stores a registry identity (refresh) token under this name, which is not a password. */
const IDENTITY_TOKEN_USERNAME = '<token>';

function runHelper(helper: string, host: string): Promise<HelperResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(`docker-credential-${helper}`, ['get'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), HELPER_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(host);
  });
}

function defaultDeps(): DockerDeps {
  return {
    readFile: (path) => readFile(path, 'utf8'),
    runHelper,
    fetch: globalThis.fetch,
    env: process.env,
    home: homedir(),
  };
}

/** `host`, `https://host` and `https://host/v1/` are the same registry in `auths`. */
const hostOf = (key: string): string => key.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

interface DockerConfig {
  auths?: Record<string, { auth?: string }>;
  credHelpers?: Record<string, string>;
  credsStore?: string;
}

async function readConfig(deps: DockerDeps): Promise<DockerConfig> {
  const dir = deps.env.DOCKER_CONFIG || join(deps.home, '.docker');

  let text: string;
  try {
    text = await deps.readFile(join(dir, 'config.json'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Undetermined(`could not read ${join(dir, 'config.json')}: ${(err as Error).message}`);
  }

  try {
    return JSON.parse(text) as DockerConfig;
  } catch {
    throw new Undetermined(`${join(dir, 'config.json')} is not valid JSON`);
  }
}

async function fromHelper(helper: string, host: string, deps: DockerDeps): Promise<Credential | null> {
  if (!HELPER_NAME.test(helper)) {
    throw new Undetermined(`the credential helper name '${helper}' in Docker's config is not valid`);
  }

  let result: HelperResult;
  try {
    result = await deps.runHelper(helper, host);
  } catch (err) {
    throw new Undetermined(`docker-credential-${helper} could not be run: ${(err as Error).message}`);
  }

  if (result.code !== 0) {
    if (HELPER_NOT_FOUND.test(result.stdout) || HELPER_NOT_FOUND.test(result.stderr)) return null;
    throw new Undetermined(`docker-credential-${helper} failed (exit ${result.code})`);
  }

  let parsed: { Username?: string; Secret?: string };
  try {
    parsed = JSON.parse(result.stdout) as { Username?: string; Secret?: string };
  } catch {
    throw new Undetermined(`docker-credential-${helper} did not answer with JSON`);
  }

  return parsed.Secret ? { username: parsed.Username ?? '', secret: parsed.Secret } : null;
}

/** Where Docker looks, in its order: `credHelpers[host]`, then `credsStore`, then `auths[host].auth`. */
export async function readDockerCredential(host: string, deps: DockerDeps = defaultDeps()): Promise<Credential | null> {
  const config = await readConfig(deps);

  const helper = config.credHelpers?.[host] ?? config.credsStore;
  if (helper) {
    const credential = await fromHelper(helper, host, deps);
    if (credential) return credential;
  }

  const entry = Object.entries(config.auths ?? {}).find(([key]) => hostOf(key) === host)?.[1];
  if (!entry?.auth) return null;

  const decoded = Buffer.from(entry.auth, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon === -1 ? null : { username: decoded.slice(0, colon), secret: decoded.slice(colon + 1) };
}

/** `Bearer realm="https://…",service="…"` -> its parameters. Null for any other scheme. */
function parseBearerChallenge(header: string | null): { realm: string; service?: string } | null {
  if (!header || !/^Bearer\s/i.test(header)) return null;

  const params: Record<string, string> = {};
  for (const [, key, value] of header.matchAll(/(\w+)="([^"]*)"/g)) {
    params[key!.toLowerCase()] = value!;
  }

  return params.realm ? { realm: params.realm, service: params.service } : null;
}

async function discoverRealm(host: string, deps: DockerDeps): Promise<{ realm: string; service?: string }> {
  const res = await deps.fetch(`https://${host}/v2/`, {
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const challenge = res.status === 401 ? parseBearerChallenge(res.headers.get('www-authenticate')) : null;
  if (!challenge) {
    throw new Undetermined(`${host} did not offer a Bearer token realm (GET /v2/ answered ${res.status})`);
  }
  return challenge;
}

interface AccessEntry {
  type?: string;
  name?: string;
  actions?: string[];
}

/** The `access` claim of a JWT. The signature is not checked: the registry will, and this only reads what was granted. */
function readAccess(token: string): AccessEntry[] {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { access?: AccessEntry[] };
    if (Array.isArray(payload.access)) return payload.access;
  } catch {
    // Falls through to the same answer as a token without the claim.
  }
  throw new Undetermined('the registry token has no readable access claim');
}

const MAX_DETAIL_LENGTH = 200;

/** The realm's own reason (`errors[0].message` in the registry error format), so a quota refusal is not blamed on the key. */
async function realmErrorMessage(res: Response): Promise<string | null> {
  const body = (await res.json().catch(() => null)) as { errors?: Array<{ message?: unknown }> } | null;
  const message = body?.errors?.[0]?.message;
  return typeof message === 'string' && message.trim() !== '' ? message.trim().slice(0, MAX_DETAIL_LENGTH) : null;
}

async function requestToken(
  challenge: { realm: string; service?: string },
  repository: string,
  credential: Credential,
  deps: DockerDeps,
): Promise<{ status: 'rejected'; httpStatus: number; detail: string | null } | { status: 'ok'; token: string }> {
  const url = new URL(challenge.realm);
  // The login only ever goes to an https realm: the registry names it, so a plain-http one is refused rather than trusted.
  if (url.protocol !== 'https:') {
    throw new Undetermined(`the token realm ${challenge.realm} is not https, so Docker's login was not sent to it`);
  }
  if (challenge.service) url.searchParams.set('service', challenge.service);
  url.searchParams.set('scope', `repository:${repository}:push,pull`);

  const res = await deps.fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Authorization: `Basic ${Buffer.from(`${credential.username}:${credential.secret}`).toString('base64')}` },
  });

  if (res.status === 401 || res.status === 403) {
    return { status: 'rejected', httpStatus: res.status, detail: await realmErrorMessage(res) };
  }
  if (!res.ok) throw new Undetermined(`the token realm answered ${res.status}`);

  const body = (await res.json().catch(() => null)) as { token?: string; access_token?: string } | null;
  const token = body?.token ?? body?.access_token;
  if (!token) throw new Undetermined('the token realm answered without a token');
  return { status: 'ok', token };
}

function verdict(check: Omit<DockerPushCheck, 'message'>, message: string): DockerPushCheck {
  return { ...check, message };
}

async function evaluate(host: string, repository: string, deps: DockerDeps): Promise<DockerPushCheck> {
  const base = { registry_host: host, repository, actions: [] as string[] };

  const credential = await readDockerCredential(host, deps);
  if (!credential) {
    return verdict({ ...base, status: 'no_credentials', can_push: false }, `Docker has no login for ${host}: run danube registry login`);
  }
  if (credential.username === IDENTITY_TOKEN_USERNAME) {
    throw new Undetermined(`Docker holds an identity token for ${host}, which this check cannot present`);
  }

  const challenge = await discoverRealm(host, deps);
  const granted = await requestToken(challenge, repository, credential, deps);
  if (granted.status === 'rejected') {
    const detail = granted.detail ? `: ${granted.detail}` : '';
    // Only a 401 says the login itself is not accepted. A 403 is the realm refusing the request (a quota, say), which a new key does not fix.
    const message = granted.httpStatus === 401
      ? `${host} rejected the login Docker has stored (HTTP 401)${detail}. It may be revoked or expired: run danube registry login`
      : `${host} refused the token request (HTTP ${granted.httpStatus})${detail}`;
    return verdict({ ...base, status: 'rejected', can_push: false }, message);
  }

  const actions = readAccess(granted.token)
    .filter((entry) => entry.type === 'repository' && entry.name === repository)
    .flatMap((entry) => entry.actions ?? []);

  if (actions.includes('push') || actions.includes('*')) {
    return verdict({ ...base, status: 'push', can_push: true, actions }, `Docker's login for ${host} can push to ${repository}`);
  }
  if (actions.includes('pull')) {
    return verdict(
      { ...base, status: 'pull_only', can_push: false, actions },
      `Docker's login for ${host} can only pull ${repository}: run danube registry login to get a key that can push`,
    );
  }
  return verdict(
    { ...base, status: 'no_access', can_push: false },
    `Docker's login for ${host} has no access to ${repository}; it may belong to another project: run danube registry login`,
  );
}

/**
 * May Docker's own login push to `repository` (a path such as `ns/app`) on `host`?
 * Never throws: a check that cannot reach a verdict says `unknown` and why, so it
 * cannot fail a command whose real answer came from the server.
 */
export async function checkDockerPush(host: string, repository: string, deps: Partial<DockerDeps> = {}): Promise<DockerPushCheck> {
  try {
    return await evaluate(host, repository, { ...defaultDeps(), ...deps });
  } catch (err) {
    const reason = err instanceof Undetermined ? err.message : `${host} could not be reached (${(err as Error).message})`;
    return verdict(
      { registry_host: host, repository, status: 'unknown', can_push: null, actions: [] },
      `Could not check Docker's credentials: ${reason}`,
    );
  }
}

/** `cr.example/ns/app:tag@sha256:…` -> its host (null when the reference has none) and repository path. */
export function parseImageReference(reference: string): { host: string | null; repository: string } {
  const parts = reference.split('@')[0]!.split('/');
  const host = parts.length > 1 && /[.:]|^localhost$/.test(parts[0]!) ? parts.shift()! : null;
  parts.push(parts.pop()!.replace(/:[^:]*$/, ''));
  return { host, repository: parts.join('/') };
}
