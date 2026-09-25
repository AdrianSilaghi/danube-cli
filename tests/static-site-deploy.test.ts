import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ApiClient } from '../src/lib/api-client.js';
import type { StaticSite, StaticSiteBuild } from '../src/types/api.js';

vi.mock('../src/lib/sleep.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

const {
  captureDeployBaseline,
  servesBuild,
  siteBaseline,
  waitForBuild,
  waitForPublish,
  waitUntilServed,
} = await import('../src/lib/static-site-deploy.js');

const SITE_ID = '01a0d8fa-35fa-709d-b9d1-319c28ba28fa';
const NEW_BUILD = '01a0d8fb-d25f-732f-aadb-b7ce5f1a8bfb';
const OLD_BUILD = '01a0d8fa-835d-70e1-bcec-b6da39e05edc';

function makeSite(overrides: Partial<StaticSite> = {}): StaticSite {
  return {
    id: SITE_ID, name: 's', slug: 's-ab12', status: 'active', last_error: null, plan: 'free',
    deploy_method: 'cli_push', url: 'https://s-ab12.pages.danubedata.ro', deployment_count: 2,
    deployed_at: null, created_at: '2026-09-25T14:31:11+00:00', updated_at: '2026-09-25T14:31:11+00:00',
    ...overrides,
  };
}

function makeBuild(overrides: Partial<StaticSiteBuild> = {}): StaticSiteBuild {
  return {
    id: NEW_BUILD, build_number: 3, status: 'succeeded', source_type: 'zip_upload', trigger_type: 'manual',
    file_count: 5, source_size_bytes: 560, duration_seconds: null, error_message: null, commit_sha: null,
    commit_message: null, created_at: '2026-09-25T14:32:57+00:00', updated_at: '2026-09-25T14:33:17+00:00',
    ...overrides,
  };
}

/** Each queue is served in order; its last entry repeats. */
function fakeApi(builds: Array<StaticSiteBuild | null>, sites: StaticSite[]) {
  const next = <T>(queue: T[]): T => (queue.length > 1 ? queue.shift()! : queue[0]!);
  const get = vi.fn(async (path: string) => ({
    data: path.endsWith('/builds/latest') ? next(builds) : next(sites),
  }));

  return { api: { get } as unknown as ApiClient, get };
}

const baseline = { buildNumber: 2, deploymentCount: 2, status: 'active', lastError: null };

describe('static site deploy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('baselines', () => {
    it('records the newest build before the upload', async () => {
      const { api } = fakeApi([makeBuild({ build_number: 7 })], [makeSite()]);

      await expect(captureDeployBaseline(api, makeSite({ deployment_count: 4 }))).resolves.toEqual({
        buildNumber: 7, deploymentCount: 4, status: 'active', lastError: null,
      });
    });

    it('starts from zero for a site that has never built', async () => {
      const { api } = fakeApi([null], [makeSite()]);

      await expect(captureDeployBaseline(api, makeSite({ deployment_count: 0, status: 'pending' }))).resolves.toMatchObject({
        buildNumber: 0, deploymentCount: 0, status: 'pending',
      });
    });

    it('reads a site baseline from the site', () => {
      expect(siteBaseline(makeSite({ status: 'error', last_error: 'boom', deployment_count: 9 }))).toEqual({
        deploymentCount: 9, status: 'error', lastError: 'boom',
      });
    });
  });

  describe('waitForBuild', () => {
    /**
     * The regression. Until the queued job creates its build record, the
     * newest build is the previous one — already succeeded. The old loop
     * reported it as this deploy's success.
     */
    it("never reports the previous build's success as this deploy's", async () => {
      const { api } = fakeApi(
        [makeBuild({ id: OLD_BUILD, build_number: 2 }), makeBuild({ build_number: 3, status: 'processing' }), makeBuild()],
        [makeSite({ status: 'building' })],
      );
      const statuses: string[] = [];

      const outcome = await waitForBuild(api, SITE_ID, baseline, (s) => statuses.push(s));

      expect(outcome).toEqual({ kind: 'built', build: makeBuild() });
      expect(statuses).toEqual(['processing', 'succeeded']);
    });

    it('reports a failed build with its error', async () => {
      const failed = makeBuild({ status: 'failed', error_message: 'No index.html found in the upload.' });
      const { api } = fakeApi([failed], [makeSite({ status: 'building' })]);

      await expect(waitForBuild(api, SITE_ID, baseline)).resolves.toEqual({
        kind: 'failed', code: 'build_failed', build: failed, message: 'No index.html found in the upload.',
      });
    });

    it('describes a cancelled build that carries no message', async () => {
      const { api } = fakeApi([makeBuild({ status: 'cancelled' })], [makeSite({ status: 'building' })]);

      await expect(waitForBuild(api, SITE_ID, baseline)).resolves.toMatchObject({
        kind: 'failed', message: 'The build was cancelled.',
      });
    });

    it('reports a duplicate-content hold as a hold', async () => {
      const held = makeSite({ status: 'pending_review', last_error: 'This deployment is on hold because its content is already published by another account.' });
      const { api } = fakeApi([makeBuild({ status: 'cancelled' })], [held]);

      await expect(waitForBuild(api, SITE_ID, baseline)).resolves.toMatchObject({
        kind: 'failed', code: 'held_for_review', message: held.last_error,
      });
    });

    it('explains a hold that carries no message', async () => {
      const { api } = fakeApi([null], [makeSite({ status: 'pending_review' })]);

      await expect(waitForBuild(api, SITE_ID, baseline)).resolves.toMatchObject({
        code: 'held_for_review', message: expect.stringContaining('on hold for review'),
      });
    });

    it('reports a suspension', async () => {
      const { api } = fakeApi([null], [makeSite({ status: 'suspended' })]);

      await expect(waitForBuild(api, SITE_ID, baseline)).resolves.toMatchObject({ kind: 'failed', code: 'suspended' });
    });

    it('reports a failure that never reached a build record', async () => {
      const { api } = fakeApi([makeBuild({ id: OLD_BUILD, build_number: 2 })], [makeSite({ status: 'error', last_error: 'A build is already in progress for this site' })]);

      await expect(waitForBuild(api, SITE_ID, baseline)).resolves.toEqual({
        kind: 'failed', code: 'build_failed', build: null, message: 'A build is already in progress for this site',
      });
    });

    it('falls back to a generic message for an error without one', async () => {
      const { api } = fakeApi([null], [makeSite({ status: 'error', last_error: null })]);

      await expect(waitForBuild(api, SITE_ID, baseline)).resolves.toMatchObject({ message: 'The deployment failed.' });
    });

    /**
     * A site already in `error` stays there until the new job starts. That
     * old failure must not be reported as this deploy's.
     */
    it("ignores the previous deploy's error until the site moves", async () => {
      const errored = { ...baseline, status: 'error', lastError: 'old failure' };
      const { api } = fakeApi(
        [null, null, makeBuild({ status: 'processing' }), makeBuild()],
        [makeSite({ status: 'error', last_error: 'old failure' }), makeSite({ status: 'error', last_error: 'old failure' }), makeSite({ status: 'building' })],
      );

      await expect(waitForBuild(api, SITE_ID, errored)).resolves.toMatchObject({ kind: 'built' });
    });

    it('counts an error once its message changes', async () => {
      const errored = { ...baseline, status: 'error', lastError: 'old failure' };
      const { api } = fakeApi([null], [makeSite({ status: 'error', last_error: 'old failure' }), makeSite({ status: 'error', last_error: 'new failure' })]);

      await expect(waitForBuild(api, SITE_ID, errored)).resolves.toMatchObject({ code: 'build_failed', message: 'new failure' });
    });

    it('counts a repeated error once the site has left the error state', async () => {
      const errored = { ...baseline, status: 'error', lastError: 'same failure' };
      const { api } = fakeApi(
        [null],
        [makeSite({ status: 'error', last_error: 'same failure' }), makeSite({ status: 'building' }), makeSite({ status: 'error', last_error: 'same failure' })],
      );

      await expect(waitForBuild(api, SITE_ID, errored)).resolves.toMatchObject({ code: 'build_failed', message: 'same failure' });
    });

    it('times out with the last build it saw', async () => {
      let now = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => (now += 60_000));
      const processing = makeBuild({ status: 'processing' });
      const { api } = fakeApi([processing], [makeSite({ status: 'building' })]);

      await expect(waitForBuild(api, SITE_ID, baseline)).resolves.toEqual({ kind: 'timeout', phase: 'build', build: processing });
    });
  });

  describe('waitForPublish', () => {
    it('waits for a newer revision that is active', async () => {
      const { api, get } = fakeApi(
        [null],
        [makeSite({ status: 'deploying' }), makeSite({ status: 'deploying', deployment_count: 3 }), makeSite({ deployment_count: 3 })],
      );

      const outcome = await waitForPublish(api, SITE_ID, baseline, true);

      expect(outcome).toEqual({ kind: 'published', site: makeSite({ deployment_count: 3 }) });
      expect(get).toHaveBeenCalledTimes(3);
    });

    it('reports a failed deploy, even one repeating the previous message', async () => {
      const errored = { ...baseline, status: 'error', lastError: 'GitOps push failed' };
      const { api } = fakeApi([null], [makeSite({ status: 'error', last_error: 'GitOps push failed' })]);

      await expect(waitForPublish(api, SITE_ID, errored, true)).resolves.toEqual({
        kind: 'failed', code: 'deploy_failed', build: null, message: 'GitOps push failed',
      });
    });

    it('waits out a stale error when rolling back an errored site', async () => {
      const errored = { deploymentCount: 2, status: 'error', lastError: 'old failure' };
      const { api } = fakeApi(
        [null],
        [makeSite({ status: 'error', last_error: 'old failure' }), makeSite({ status: 'deploying' }), makeSite({ deployment_count: 3 })],
      );

      await expect(waitForPublish(api, SITE_ID, errored, false)).resolves.toMatchObject({ kind: 'published' });
    });

    it('times out', async () => {
      let now = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => (now += 60_000));
      const { api } = fakeApi([null], [makeSite({ status: 'deploying' })]);

      await expect(waitForPublish(api, SITE_ID, baseline, true)).resolves.toEqual({ kind: 'timeout', phase: 'publish', build: null });
    });
  });

  describe('servesBuild', () => {
    it('accepts a page stamped with the new build', () => {
      expect(servesBuild(`<link href="/a.css?v=${NEW_BUILD}">`, NEW_BUILD)).toBe(true);
    });

    it("rejects a page stamped with another build — that is the previous revision", () => {
      expect(servesBuild(`<script src="/app.js?v=${OLD_BUILD}"></script>`, NEW_BUILD)).toBe(false);
    });

    it('accepts an unstamped page, which cannot be told apart', () => {
      expect(servesBuild('<h1>hello</h1>', NEW_BUILD)).toBe(true);
    });
  });

  describe('waitUntilServed', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, 'fetch');
    });

    it('probes the site root and reports live once the new build is served', async () => {
      fetchSpy
        .mockResolvedValueOnce(new Response('default backend - 404', { status: 404 }))
        .mockResolvedValueOnce(new Response(`<link href="/s.css?v=${OLD_BUILD}">`, { status: 200 }))
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(new Response(`<link href="/s.css?v=${NEW_BUILD}">`, { status: 200 }));

      await expect(waitUntilServed('https://s-ab12.pages.danubedata.ro', NEW_BUILD)).resolves.toBe('live');

      expect(fetchSpy).toHaveBeenCalledTimes(4);
      expect(fetchSpy.mock.calls[0]![0]).toBe('https://s-ab12.pages.danubedata.ro/');
    });

    it('stops at a password prompt, which it cannot see past', async () => {
      fetchSpy.mockResolvedValue(new Response('', { status: 401 }));

      await expect(waitUntilServed('https://s-ab12.pages.danubedata.ro', NEW_BUILD)).resolves.toBe('password_protected');
    });

    it('gives up without a verdict when the new version never appears', async () => {
      let now = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => (now += 30_000));
      fetchSpy.mockImplementation(async () => new Response(`<script src="/a.js?v=${OLD_BUILD}"></script>`, { status: 200 }));

      await expect(waitUntilServed('https://s-ab12.pages.danubedata.ro', NEW_BUILD)).resolves.toBe('not_confirmed');
    });

    it('does not probe a URL it cannot parse', async () => {
      await expect(waitUntilServed('not a url', NEW_BUILD)).resolves.toBe('not_confirmed');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
