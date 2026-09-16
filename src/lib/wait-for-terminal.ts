import type { ApiClient } from './api-client.js';
import type { ServerlessShowResponse, ServerlessStatusDetails } from '../types/api.js';

/** Poll interval. The platform reconciles on the order of seconds. */
const POLL_INTERVAL_MS = 3_000;

/** Default ceiling. Image pulls and cold buildpack builds are the slow cases. */
export const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60_000;

/**
 * What the container looked like BEFORE the mutation.
 *
 * Without this the poller cannot tell a settled verdict about the NEW operation
 * from a leftover verdict about the previous one, and the first poll — issued
 * milliseconds after the write — reports the old revision's success as if it
 * were the new one's. That is a false success, which for an unattended agent is
 * worse than any error.
 */
export interface WaitBaseline {
  observedAt: string | null;
  currentRevision: string | null;
  deploymentCount: number | null;
}

export interface WaitResult {
  /** False when the timeout elapsed first. The resource is unaffected either way. */
  settled: boolean;
  status: ServerlessStatusDetails | null;
  url: string | null;
  waitedMs: number;
  /** Revision serving at the moment the wait ended. */
  targetRevision: string | null;
  /** When the platform last observed the cluster. Server clock. */
  observedAt: string | null;
  /**
   * Whether the platform was seen to re-observe the container after the write.
   * False alongside `settled: false` means we never got fresh evidence — the
   * verdict is about the PREVIOUS state and must not be trusted.
   *
   * When `minGeneration` gated the verdict instead (see below), this still
   * reports true once `observed_generation` catches up — the generation is
   * strictly better evidence of freshness than the baseline heuristic this
   * flag was built for, not a different question.
   */
  sawFreshObservation: boolean;
  /**
   * The last numeric `observed_generation` seen, or null if the server never
   * reported one. Present even when `minGeneration` was not supplied, so a
   * caller can inspect it without asking for the gate.
   */
  observedGeneration: number | null;
}

/**
 * Has the platform looked at this container since the mutation?
 *
 * Compares only server-produced values against each other; the client clock is
 * never compared to a server timestamp, so clock skew cannot make a stale
 * verdict look fresh.
 */
function isFreshObservation(
  status: ServerlessStatusDetails | null,
  container: { current_revision?: string | null; deployment_count?: number },
  baseline: WaitBaseline,
): boolean {
  if ((status?.observed_at ?? null) !== baseline.observedAt) return true;
  if ((container.current_revision ?? null) !== baseline.currentRevision) return true;
  if ((container.deployment_count ?? null) !== baseline.deploymentCount) return true;

  return false;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Block until a container reaches a terminal state.
 *
 * Terminality comes from `status_details.operation.terminal` and nothing else.
 * Inferring it from the status string is how polling loops hang forever: the
 * string is written for humans and its value domain grows over time, whereas
 * `terminal` is an explicit boolean the platform is obliged to set.
 *
 * `summary: "degraded"` IS terminal and is not an outage — a new revision
 * failed while an older one keeps serving. Callers decide what to do about
 * that; this function only decides when to stop asking.
 *
 * Timing out is not an error. It means the deploy is still in flight, so the
 * caller is told plainly rather than being handed a fabricated verdict.
 */
export async function waitForTerminal(
  api: ApiClient,
  containerId: string,
  opts: {
    timeoutMs?: number;
    onTick?: (status: ServerlessStatusDetails | null) => void;
    /**
     * Pre-mutation snapshot. Omit ONLY when the resource did not exist before
     * (a create), where there is no previous verdict to be confused with.
     */
    baseline?: WaitBaseline | null;
    /**
     * The `spec_generation` the mutation this wait follows produced (from the
     * create/update response). A server that also reports
     * `observed_generation` on every poll is naming exactly which change its
     * `status_details` describes — direct evidence, and strictly better than
     * `baseline`, which exists only to approximate this when the server
     * cannot say it directly. When both are available a terminal verdict is
     * accepted once `observed_generation >= minGeneration`, and `baseline` is
     * not consulted at all. Pass `null` (or omit) when there is no generation
     * to wait for, or when talking to a server that predates it — the
     * baseline heuristic then applies exactly as before.
     */
    minGeneration?: number | null;
  } = {},
): Promise<WaitResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const baseline = opts.baseline ?? null;
  const minGeneration = opts.minGeneration ?? null;
  const startedAt = Date.now();
  let sawFresh = baseline === null;
  let observedGeneration: number | null = null;

  for (;;) {
    const res = await api.get<ServerlessShowResponse>(`/api/v1/serverless/${containerId}`);
    const status = res.container.status_details ?? null;
    const generation = res.container.observed_generation;
    // Only trust generation-based freshness when THIS poll reports a number —
    // a server that omits the field on some response (or every response)
    // must fall through to the baseline heuristic for that poll, not crash.
    const usingGeneration = minGeneration !== null && typeof generation === 'number';
    if (typeof generation === 'number') observedGeneration = generation;

    const done = (settled: boolean): WaitResult => ({
      settled,
      status,
      url: res.url ?? null,
      waitedMs: Date.now() - startedAt,
      targetRevision: res.container.current_revision ?? null,
      observedAt: status?.observed_at ?? null,
      sawFreshObservation: sawFresh,
      observedGeneration,
    });

    opts.onTick?.(status);

    if (usingGeneration) {
      if (generation! >= minGeneration!) sawFresh = true;
    } else if (baseline !== null && !sawFresh && isFreshObservation(status, res.container, baseline)) {
      sawFresh = true;
    }

    // Terminal is necessary but NOT sufficient. Immediately after a write the
    // platform has not re-reconciled yet, so `terminal` is still the PREVIOUS
    // operation's verdict — that is how apply --wait returned success in 0.6s
    // while naming the old revision. Require fresh evidence too (the
    // generation check above, or the baseline heuristic).
    if (status?.operation?.terminal === true && sawFresh) {
      return done(true);
    }

    // A server that predates typed status_details cannot be polled this way.
    // Say so instead of spinning until the timeout on a field that will never
    // appear.
    if (status === null) {
      return done(false);
    }

    if (Date.now() - startedAt + POLL_INTERVAL_MS > timeoutMs) {
      return done(false);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

/** Snapshot a container so a later wait can tell new verdicts from stale ones. */
export async function captureBaseline(api: ApiClient, containerId: string): Promise<WaitBaseline> {
  const res = await api.get<ServerlessShowResponse>(`/api/v1/serverless/${containerId}`);

  return {
    observedAt: res.container.status_details?.observed_at ?? null,
    currentRevision: res.container.current_revision ?? null,
    deploymentCount: res.container.deployment_count ?? null,
  };
}
