import chalk from 'chalk';
import { ApiError } from './errors.js';
import { isJsonMode, jsonError } from './json-mode.js';

/**
 * Exact wording the product requires: every `rapids run(s)` command prints
 * this, verbatim, when the account is not on the `rapids-runs` flag yet.
 */
export const RUNS_NOT_ENABLED_MESSAGE = 'Rapids runs are not enabled for this account yet.';

/**
 * Every runs endpoint 404s identically while the feature is off for the
 * account — indistinguishable, by contract, from any other reason the route
 * might 404. Wrapping every runs-endpoint call here means all five commands
 * report the gate in one voice instead of each falling through to a generic
 * "API Error (404)" that never says what to do about it.
 *
 * Callers pass the resolved container's runs call (or a whole `waitForRun`),
 * never the container-resolution call itself — `resolveContainer` already
 * reports a missing CONTAINER on its own terms via `ResourceNotFoundError`,
 * which this does not touch.
 */
export async function runsApi<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 404) {
      if (isJsonMode()) {
        jsonError({ code: 'serverless.runs_not_enabled', message: RUNS_NOT_ENABLED_MESSAGE });
      } else {
        console.error(chalk.red(RUNS_NOT_ENABLED_MESSAGE));
      }
      process.exit(1);
    }
    throw err;
  }
}
