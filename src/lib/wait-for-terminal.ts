import type { ApiClient } from './api-client.js';
import type { ServerlessShowResponse, ServerlessStatusDetails } from '../types/api.js';

/** Poll interval. The platform reconciles on the order of seconds. */
const POLL_INTERVAL_MS = 3_000;

/** Default ceiling. Image pulls and cold buildpack builds are the slow cases. */
export const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60_000;

export interface WaitResult {
  /** False when the timeout elapsed first. The resource is unaffected either way. */
  settled: boolean;
  status: ServerlessStatusDetails | null;
  url: string | null;
  waitedMs: number;
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
  opts: { timeoutMs?: number; onTick?: (status: ServerlessStatusDetails | null) => void } = {},
): Promise<WaitResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const startedAt = Date.now();

  for (;;) {
    const res = await api.get<ServerlessShowResponse>(`/api/v1/serverless/${containerId}`);
    const status = res.container.status_details ?? null;

    opts.onTick?.(status);

    if (status?.operation?.terminal === true) {
      return { settled: true, status, url: res.url ?? null, waitedMs: Date.now() - startedAt };
    }

    // A server that predates typed status_details cannot be polled this way.
    // Say so instead of spinning until the timeout on a field that will never
    // appear.
    if (status === null) {
      return { settled: false, status: null, url: res.url ?? null, waitedMs: Date.now() - startedAt };
    }

    if (Date.now() - startedAt + POLL_INTERVAL_MS > timeoutMs) {
      return { settled: false, status, url: res.url ?? null, waitedMs: Date.now() - startedAt };
    }

    await sleep(POLL_INTERVAL_MS);
  }
}
