import chalk from 'chalk';
import type { WaitResult } from './wait-for-terminal.js';
import type { ServerlessContainer } from '../types/api.js';

/**
 * Shared by every `rapids` mutation that supports `--wait` (`apply`,
 * `update`, and anything else that converges a container). Extracted from
 * `apply --wait`, the original implementation, so all of them describe the
 * same wait in the same words instead of drifting apart one copy-paste at a
 * time.
 */

/**
 * Compact result. The full container resource is ~60 fields of git/build
 * defaults that have nothing to do with the outcome; an agent pays for every
 * one of them and has to find the four that matter.
 */
export function waitEnvelope(action: string, container: ServerlessContainer, wait: WaitResult) {
  return {
    action,
    container_id: container.id,
    name: container.name,
    settled: wait.settled,
    terminal: wait.status?.operation.terminal ?? null,
    summary: wait.status?.summary ?? null,
    health: wait.status?.health ?? null,
    target_revision: wait.targetRevision,
    // Server clock, so a caller can tell a fresh verdict from a cached one.
    observed_at: wait.observedAt,
    // False means we never saw the platform re-observe after the write, so the
    // verdict above describes the PREVIOUS state.
    fresh_observation: wait.sawFreshObservation,
    url: wait.url,
    error: wait.status?.error ?? null,
    waited_ms: wait.waitedMs,
  };
}

export function printWaitOutcome(wait: WaitResult, name: string): void {
  const status = wait.status;
  if (!wait.settled) {
    if (!wait.sawFreshObservation) {
      console.error(chalk.yellow(
        'Timed out before the platform re-observed this container, so no verdict here would describe your change.',
      ));
    } else {
      console.error(chalk.yellow(`Still deploying (${status?.summary ?? 'unknown'}). Not a failure — the rollout continues.`));
    }
    console.error(chalk.dim(`Watch: danube rapids diagnose ${name} --json`));
    return;
  }
  if (wait.targetRevision) console.log(chalk.dim(`Revision: ${wait.targetRevision}`));
  if (status?.summary === 'ready') {
    console.log(chalk.green('Ready'));
    if (wait.url) console.log(`URL: ${wait.url}`);
    return;
  }
  if (status?.summary === 'degraded') {
    console.log(chalk.yellow('Degraded — the new revision failed, an older one is still serving.'));
    if (wait.url) console.log(`URL: ${wait.url}`);
  } else {
    console.log(chalk.red(String(status?.summary ?? 'unknown')));
  }
  if (status?.error) {
    console.log(`  ${chalk.bold(status.error.code)}${status.error.retryable ? chalk.dim(' (retryable)') : ''}`);
    if (status.error.message) console.log(`  ${status.error.message}`);
  }
  console.log(chalk.dim(`  danube rapids diagnose ${name} --json`));
}
