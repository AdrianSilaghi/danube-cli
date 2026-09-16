import chalk from 'chalk';
import { ApiError } from './errors.js';
import { isJsonMode, jsonError } from './json-mode.js';

/**
 * Exact wording the product requires: every `rapids run(s)` command prints
 * this, verbatim, when the account is not on the `rapids-runs` flag yet.
 */
export const RUNS_NOT_ENABLED_MESSAGE = 'Rapids runs are not enabled for this account yet.';

/**
 * The API's own code for the flag-off case. A 404 carrying it is unambiguous
 * regardless of which run or container it names; a 404 WITHOUT it means
 * something else — a route that does not exist at all (no code to give), or
 * this particular run is not there.
 */
const RUNS_NOT_ENABLED_CODE = 'serverless.runs_not_enabled';

function is404(err: unknown): err is ApiError {
  return err instanceof ApiError && err.statusCode === 404;
}

function isNotEnabled(err: ApiError): boolean {
  return err.cause?.code === RUNS_NOT_ENABLED_CODE;
}

function reportNotEnabled(): never {
  if (isJsonMode()) {
    jsonError({ code: RUNS_NOT_ENABLED_CODE, message: RUNS_NOT_ENABLED_MESSAGE });
  } else {
    console.error(chalk.red(RUNS_NOT_ENABLED_MESSAGE));
  }
  process.exit(1);
}

/**
 * Wrap a runs-endpoint call that names no specific run — `POST .../runs`
 * and `GET .../runs`. A 404 here always means "not reachable at all": with
 * the code, the account is not on the flag; without it, a server that has
 * not deployed the feature yet has no route to 404 helpfully from — either
 * way there is no run to distinguish it from, so both read the same.
 *
 * Callers pass the resolved container's runs call, never the
 * container-resolution call itself — `resolveContainer` already reports a
 * missing CONTAINER on its own terms via `ResourceNotFoundError`, which
 * this does not touch.
 */
export async function runsApi<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (is404(err)) reportNotEnabled();
    throw err;
  }
}

/**
 * Wrap a call that names a specific run — `GET/POST .../runs/{id}[...]`, and
 * anything that polls one. The coded 404 is still checked first, so the
 * flag-off signal cannot be shadowed by which run happened to be named; an
 * uncoded 404 means THIS run specifically is not there, and `onMissing` says
 * what that means for the caller's own wording — never found at all
 * (`reportRunNotFound`) vs. gone mid-poll (`reportRunDisappeared`).
 */
export async function runsApiForRun<T>(call: () => Promise<T>, onMissing: () => never): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (is404(err)) {
      if (isNotEnabled(err)) reportNotEnabled();
      onMissing();
    }
    throw err;
  }
}

/** `runs show|logs|cancel`: an uncoded 404 means this run id was never there. */
export function reportRunNotFound(runId: string, containerName: string): never {
  const message = `Run ${runId} was not found on ${containerName}.`;
  if (isJsonMode()) {
    jsonError({ code: 'not_found', message });
  } else {
    console.error(chalk.red(message));
  }
  process.exit(1);
}

/** `run --wait` / `runs logs --follow`: an uncoded 404 mid-poll means the run disappeared. */
export function reportRunDisappeared(runId: string): never {
  const message = `Run ${runId} disappeared while waiting for it to finish.`;
  if (isJsonMode()) {
    jsonError({ code: 'serverless.run_disappeared', message });
  } else {
    console.error(chalk.red(message));
  }
  process.exit(1);
}
