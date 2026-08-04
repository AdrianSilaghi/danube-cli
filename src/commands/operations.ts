import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../lib/api-client.js';
import { isJsonMode, jsonEnvelope } from '../lib/json-mode.js';
import { parseDuration } from '../lib/duration.js';
import { sleep } from '../lib/sleep.js';

const DEFAULT_TIMEOUT = '30m';
/** Used only when the server declines to say; the server normally sets the pace. */
const FALLBACK_POLL_MS = 3_000;

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message?: string; retryable?: boolean } | null;
  meta?: Record<string, unknown>;
}

export interface Operation {
  operation_id: string;
  resource_id: string;
  resource_type: string;
  kind: string;
  state: string;
  terminal: boolean;
  poll_after_ms: number | null;
  revision: string | null;
  knative_revision: string | null;
  image: string | null;
  started_at: string | null;
  finished_at: string | null;
  error: { code: string; message: string; retryable: boolean; reason: string | null } | null;
}

const fetchOperation = async (api: ApiClient, id: string): Promise<Envelope<Operation>> =>
  api.get<Envelope<Operation>>(`/api/v1/operations/${encodeURIComponent(id)}`);

function stateColour(op: Operation): string {
  if (op.state === 'succeeded') return chalk.green(op.state);
  if (op.state === 'failed' || op.state === 'cancelled') return chalk.red(op.state);

  return chalk.yellow(op.state);
}

function printHuman(op: Operation): void {
  console.log(`${op.kind} ${op.operation_id}`);
  console.log(`  state:    ${stateColour(op)}`);
  console.log(`  terminal: ${op.terminal}`);
  if (op.revision) console.log(`  revision: ${op.revision}`);
  if (op.image) console.log(`  image:    ${op.image}`);
  if (op.error) {
    console.log(chalk.red(`  error:    ${op.error.code}`));
    console.log(`            ${op.error.message}`);
    console.log(chalk.dim(`            retryable: ${op.error.retryable ? 'yes' : 'no'}`));
  }
}

const inspectCommand = new Command('inspect')
  .description('Show the current state of an operation')
  .argument('<operation-id>', 'Operation id, or the id of the resource it acts on')
  .action(async (operationId: string) => {
    const api = await ApiClient.create();
    const res = await fetchOperation(api, operationId);

    if (isJsonMode()) {
      jsonEnvelope(res.data, { error: res.error ?? null, meta: res.meta ?? {} });
      return;
    }

    printHuman(res.data);
  });

const waitCommand = new Command('wait')
  .description('Block until an operation reaches a terminal state')
  .argument('<operation-id>', 'Operation id, or the id of the resource it acts on')
  .option('--timeout <duration>', 'Give up after this long (30m, 90s, 2h)', DEFAULT_TIMEOUT)
  .action(async (operationId: string, options: { timeout: string }) => {
    const timeoutMs = parseDuration(options.timeout);
    const api = await ApiClient.create();
    const startedAt = Date.now();

    let operation: Operation | null = null;
    let polls = 0;

    while (Date.now() - startedAt < timeoutMs) {
      const res = await fetchOperation(api, operationId);
      operation = res.data;
      polls++;

      // `terminal` is the stop condition, and the only one. Inferring it from
      // `state` means every new state name silently becomes "keep waiting" in
      // one client and "finished" in another.
      if (operation.terminal) break;

      // The server sets the pace so it can change without updating clients.
      await sleep(operation.poll_after_ms ?? FALLBACK_POLL_MS);
    }

    const elapsedMs = Date.now() - startedAt;
    const timedOut = !operation?.terminal;

    if (isJsonMode()) {
      jsonEnvelope(operation, {
        // A timeout is not a failure of the operation — the deploy may well
        // still be running. Saying so is the difference between a caller
        // waiting longer and a caller rolling back something that was fine.
        error: timedOut
          ? {
            code: 'operation.wait_timeout',
            message: `Still ${operation?.state ?? 'unknown'} after ${Math.round(elapsedMs / 1000)}s. The operation has not failed; it has not finished.`,
            retryable: true,
          }
          : null,
        meta: { polls, elapsed_ms: elapsedMs, timeout_ms: timeoutMs },
      });
    } else if (timedOut) {
      console.error(chalk.yellow(`Timed out after ${Math.round(elapsedMs / 1000)}s — still ${operation?.state ?? 'unknown'}.`));
      console.error(chalk.dim('The operation has not failed. Increase --timeout or inspect it later.'));
    } else {
      printHuman(operation!);
    }

    // Succeeded is the only zero. A failed operation and a timeout both need a
    // non-zero exit for a pipeline to branch on.
    if (timedOut || operation?.state !== 'succeeded') process.exitCode = 1;
  });

export const operationsCommand = new Command('operations')
  .alias('operation')
  .description('Inspect and wait on long-running operations');

operationsCommand.addCommand(inspectCommand);
operationsCommand.addCommand(waitCommand);
