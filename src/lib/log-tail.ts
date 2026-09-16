import chalk from 'chalk';
import type { ApiClient } from './api-client.js';
import { sanitize } from './log-text.js';

export interface LogTailState {
  printed: string;
}

/**
 * Diff the full log text against what this tail already printed.
 *
 * `GET .../runs/{id}/logs` returns the whole available text/tail on every
 * call, not a delta since last time, so the delta is computed here. If `next`
 * no longer starts with what was already printed, the tail window moved (the
 * store dropped its oldest lines) and there is no reliable join point — the
 * caller marks the gap rather than guess at what was missed, and takes `next`
 * in full.
 */
export function diffLogTail(state: LogTailState, next: string): { fresh: string; moved: boolean } {
  const prev = state.printed;
  state.printed = next;

  if (next === prev) return { fresh: '', moved: false };
  if (next.startsWith(prev)) return { fresh: next.slice(prev.length), moved: false };
  return { fresh: next, moved: true };
}

/**
 * Fetch the current log text for one poll tick and print only what is new.
 *
 * Best-effort: a fetch failure here is swallowed rather than thrown. This
 * runs inside a run's status-polling loop, whose own terminal check is the
 * source of truth for the outcome — a log-fetch hiccup on one tick must not
 * abort that wait, only skip this tick's text.
 */
export async function streamNewLogs(
  api: ApiClient,
  path: string,
  state: LogTailState,
  write: (text: string) => void,
): Promise<void> {
  try {
    const res = await api.get<{ data: { logs: string } }>(path);
    const { fresh, moved } = diffLogTail(state, res.data.logs);
    if (moved) write(chalk.dim('…\n'));
    if (fresh) write(sanitize(fresh));
  } catch {
    // Best-effort — see doc comment above.
  }
}
