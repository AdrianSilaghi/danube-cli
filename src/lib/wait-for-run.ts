import type { ApiClient } from './api-client.js';
import { sleep } from './sleep.js';
import type { Envelope, ServerlessRun } from '../types/api.js';

/** Poll interval. Matches wait-for-terminal.ts — the platform reconciles on the order of seconds. */
const POLL_INTERVAL_MS = 3_000;

/** Default ceiling for a client wait. Matches wait-for-terminal.ts's default. */
export const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60_000;

export interface RunWaitResult {
  /** False when the CLIENT's timeout elapsed first — the run itself may still be active. */
  settled: boolean;
  run: ServerlessRun;
  waitedMs: number;
}

/**
 * Block until a run reaches a terminal state.
 *
 * Unlike `waitForTerminal` (containers, which accumulate history on one id
 * and so need a baseline snapshot to tell a fresh verdict from a stale one),
 * a run id is minted fresh by the `POST` that created it — there is no
 * earlier verdict it could be confused with. So this is a plain poll against
 * `terminal`, the same stop condition, never inferred from `status`.
 */
export async function waitForRun(
  api: ApiClient,
  containerId: string,
  runId: string,
  opts: {
    timeoutMs?: number;
    /** Fires every poll, including the terminal one — a caller streaming logs wants the final tail too. */
    onTick?: (run: ServerlessRun) => void | Promise<void>;
  } = {},
): Promise<RunWaitResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const startedAt = Date.now();

  for (;;) {
    const res = await api.get<Envelope<ServerlessRun>>(`/api/v1/serverless/${containerId}/runs/${runId}`);
    const run = res.data;

    await opts.onTick?.(run);

    if (run.terminal) {
      return { settled: true, run, waitedMs: Date.now() - startedAt };
    }

    if (Date.now() - startedAt + POLL_INTERVAL_MS > timeoutMs) {
      return { settled: false, run, waitedMs: Date.now() - startedAt };
    }

    await sleep(POLL_INTERVAL_MS);
  }
}
