import type { ApiClient } from './api-client.js';
import type { StaticSite, StaticSiteBuild } from '../types/api.js';
import { sleep } from './sleep.js';
import { getCurrentVersion } from './version.js';

export const POLL_INTERVAL_MS = 2_000;
/** The platform gives a build ten minutes; the CLI reports at five and says where to look. */
export const BUILD_TIMEOUT_MS = 5 * 60_000;
/** Committing the new revision. Seconds, normally. */
export const PUBLISH_TIMEOUT_MS = 3 * 60_000;
/** The rollout, observed from outside. Normally 10–20 seconds. */
export const SERVE_TIMEOUT_MS = 90_000;
const PROBE_TIMEOUT_MS = 10_000;

/**
 * The site as it was BEFORE the upload or rollback.
 *
 * `builds/latest` answers "the newest build", not "the build this upload
 * started". Until the queued job creates its build record the newest build is
 * the previous one — and it already succeeded. Polling without a baseline
 * reported that earlier build as this deploy's success, then printed "Live"
 * for content that had not been built yet.
 */
export interface SiteBaseline {
  deploymentCount: number;
  status: string;
  lastError: string | null;
}

export interface DeployBaseline extends SiteBaseline {
  /** 0 when the site has never been built. */
  buildNumber: number;
}

export type DeployFailureCode = 'build_failed' | 'deploy_failed' | 'held_for_review' | 'suspended';

export interface DeployFailure {
  kind: 'failed';
  code: DeployFailureCode;
  message: string;
  build: StaticSiteBuild | null;
}

export interface DeployTimeout {
  kind: 'timeout';
  phase: 'build' | 'publish';
  build: StaticSiteBuild | null;
}

export type BuildOutcome = { kind: 'built'; build: StaticSiteBuild } | DeployFailure | DeployTimeout;
export type PublishOutcome = { kind: 'published'; site: StaticSite } | DeployFailure | DeployTimeout;
export type ServeOutcome = 'live' | 'password_protected' | 'not_confirmed';

function siteBaseline(site: StaticSite): SiteBaseline {
  return { deploymentCount: site.deployment_count, status: site.status, lastError: site.last_error };
}

/**
 * Read the site immediately before the mutating call, never earlier: a
 * revision recorded in between — a slow paginated listing is enough time for
 * someone else's deploy — would otherwise be mistaken for this one's.
 */
export async function captureSiteBaseline(api: ApiClient, siteId: string): Promise<SiteBaseline> {
  return siteBaseline(await fetchSite(api, siteId));
}

export async function captureDeployBaseline(api: ApiClient, siteId: string): Promise<DeployBaseline> {
  const [site, build] = await Promise.all([fetchSite(api, siteId), fetchLatestBuild(api, siteId)]);

  return { ...siteBaseline(site), buildNumber: build?.build_number ?? 0 };
}

async function fetchLatestBuild(api: ApiClient, siteId: string): Promise<StaticSiteBuild | null> {
  const res = await api.get<{ data: StaticSiteBuild | null }>(`/api/v1/static-sites/${siteId}/builds/latest`);

  return res.data;
}

async function fetchSite(api: ApiClient, siteId: string): Promise<StaticSite> {
  const res = await api.get<{ data: StaticSite }>(`/api/v1/static-sites/${siteId}`);

  return res.data;
}

/**
 * Is an `error` status about THIS deploy, or left over from an earlier one?
 *
 * A site that was already in `error` stays there until the new job starts, so
 * the first polls see the old failure. It counts once the site has been seen
 * in any other state since the baseline, or once its message has changed.
 * Only server-produced values are compared, never the client clock.
 */
function freshErrorDetector(baseline: SiteBaseline, alreadyLeftError: boolean): (site: StaticSite) => boolean {
  let leftError = alreadyLeftError || baseline.status !== 'error';

  return (site) => {
    if (site.status !== 'error') {
      leftError = true;

      return false;
    }

    return leftError || site.last_error !== baseline.lastError;
  };
}

/**
 * A site-level verdict that ends the wait whatever the build record says: a
 * duplicate-content hold, a suspension, or a failure that never reached a
 * build record (the job refused before creating one).
 */
function siteFailure(
  site: StaticSite,
  code: 'build_failed' | 'deploy_failed',
  build: StaticSiteBuild | null,
  isFreshError: (site: StaticSite) => boolean,
): DeployFailure | null {
  if (site.status === 'pending_review') {
    const message = site.last_error ?? 'This deployment is on hold for review. Contact support if you believe this is a mistake.';

    return { kind: 'failed', code: 'held_for_review', build, message };
  }

  if (site.status === 'suspended') {
    return { kind: 'failed', code: 'suspended', build, message: 'This site is suspended and cannot be deployed. Contact support.' };
  }

  if (isFreshError(site)) {
    return { kind: 'failed', code, build, message: site.last_error ?? 'The deployment failed.' };
  }

  return null;
}

/**
 * Wait for the build this upload started — never an earlier one.
 */
export async function waitForBuild(
  api: ApiClient,
  siteId: string,
  baseline: DeployBaseline,
  onStatus?: (status: string) => void,
): Promise<BuildOutcome> {
  const deadline = Date.now() + BUILD_TIMEOUT_MS;
  const isFreshError = freshErrorDetector(baseline, false);
  let mine: StaticSiteBuild | null = null;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const latest = await fetchLatestBuild(api, siteId);
    if (latest && latest.build_number > baseline.buildNumber) {
      mine = latest;
      onStatus?.(mine.status);

      if (mine.status === 'succeeded') return { kind: 'built', build: mine };
    }

    const site = await fetchSite(api, siteId);
    const failure = siteFailure(site, 'build_failed', mine, isFreshError);
    if (failure) return failure;

    if (mine && (mine.status === 'failed' || mine.status === 'cancelled')) {
      return { kind: 'failed', code: 'build_failed', build: mine, message: mine.error_message ?? `The build was ${mine.status}.` };
    }
  }

  return { kind: 'timeout', phase: 'build', build: mine };
}

/**
 * Wait for the platform to record a revision newer than the baseline.
 *
 * `alreadyLeftError` is true after a successful build: the build job moved the
 * site out of any earlier `error`, so an `error` seen now is this deploy's.
 */
export async function waitForPublish(
  api: ApiClient,
  siteId: string,
  baseline: SiteBaseline,
  alreadyLeftError: boolean,
): Promise<PublishOutcome> {
  const deadline = Date.now() + PUBLISH_TIMEOUT_MS;
  const isFreshError = freshErrorDetector(baseline, alreadyLeftError);

  while (Date.now() < deadline) {
    const site = await fetchSite(api, siteId);

    if (site.deployment_count > baseline.deploymentCount && site.status === 'active') {
      return { kind: 'published', site };
    }

    const failure = siteFailure(site, 'deploy_failed', null, isFreshError);
    if (failure) return failure;

    await sleep(POLL_INTERVAL_MS);
  }

  return { kind: 'timeout', phase: 'publish', build: null };
}

/**
 * The platform stamps every CSS and JS reference in a published page with the
 * build that produced it (`style.css?v=<build id>`) to bust browser caches. A
 * page stamped by another build is the previous revision, still serving. A
 * page with no stamp cannot be told apart, so it counts once it is served.
 */
const BUILD_STAMP = /\.(?:css|js)\?v=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function servesBuild(html: string, buildId: string): boolean {
  return html.includes(`?v=${buildId}`) || !BUILD_STAMP.test(html);
}

type ProbeVerdict = 'serving' | 'protected' | 'waiting';

async function probeSite(url: string, buildId: string): Promise<ProbeVerdict> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': `DanubeCLI/${getCurrentVersion()}`, 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (res.status === 401) return 'protected';
    if (!res.ok) return 'waiting';

    return servesBuild(await res.text(), buildId) ? 'serving' : 'waiting';
  } catch {
    // Not resolvable yet, TLS not ready, connection reset mid-rollout: all
    // "not yet", none of them a verdict on the deploy.
    return 'waiting';
  }
}

/**
 * Confirm from outside that the site serves the new build.
 *
 * A revision is recorded before its rollout finishes. On a first deploy the
 * URL answered "default backend - 404" for 10–20 seconds after the CLI said
 * "Live at"; on a redeploy it kept serving the previous version for as long.
 */
export async function waitUntilServed(siteUrl: string, buildId: string): Promise<ServeOutcome> {
  let url: string;
  try {
    url = new URL('/', siteUrl).toString();
  } catch {
    return 'not_confirmed';
  }

  const deadline = Date.now() + SERVE_TIMEOUT_MS;

  for (;;) {
    const verdict = await probeSite(url, buildId);
    if (verdict === 'serving') return 'live';
    if (verdict === 'protected') return 'password_protected';
    if (Date.now() >= deadline) return 'not_confirmed';

    await sleep(POLL_INTERVAL_MS);
  }
}
