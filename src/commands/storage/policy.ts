import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client.js';
import { resolveResource } from '../../lib/resolve.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import { confirmDestruction } from '../../lib/interactive.js';
import { printDetails, statusColor } from '../../lib/output.js';
import { MissingFlagsError, UsageError } from '../../lib/errors.js';
import { readInput, STDIN_SOURCE } from '../../lib/read-input.js';
import { parseKeyLevel, resolveAccessKey } from '../../lib/storage-keys.js';
import { policyApi, parsePolicyStatements, policyPath, folderGrantsPath, POLICY_UPDATING } from '../../lib/bucket-policy.js';
import { finishChange, waitCeiling, type WaitFlags } from '../../lib/policy-change.js';
import type {
  BucketPolicy,
  BucketPolicyGrant,
  BucketPolicyStatement,
  StorageAccessKey,
  StorageBucket,
  StorageKeyLevel,
} from '../../types/api.js';

const resolveBucket = (api: ApiClient, reference: string): Promise<StorageBucket> =>
  resolveResource<StorageBucket>(api, '/api/v1/storage/buckets', 'bucket', reference);

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** A spinner for the request, for a person; nothing in JSON mode. */
async function sending<T>(label: string, call: () => Promise<T>): Promise<T> {
  const spinner = isJsonMode() ? null : ora(label).start();

  try {
    return await call();
  } finally {
    spinner?.stop();
  }
}

// --- policy get --------------------------------------------------------------

function printPolicy(bucketName: string, policy: BucketPolicy, withEffective: boolean): void {
  printDetails([['Bucket', bucketName], ['Status', statusColor(policy.status)]]);

  if (policy.status === POLICY_UPDATING) {
    console.log(chalk.dim('A change is on its way to the storage gateway; ask again in a moment to see it finish.'));
  }

  console.log('');
  console.log(chalk.bold(`Custom statements (${policy.custom_policy_statements.length})`));
  console.log(JSON.stringify(policy.custom_policy_statements, null, 2));

  if (!withEffective) return;

  console.log('');
  console.log(chalk.bold('Effective policy'));
  console.log(policy.effective_policy ? JSON.stringify(policy.effective_policy, null, 2) : 'none');
}

const getCommand = new Command('get')
  .description("Show a bucket's policy: its status and the custom statements")
  .argument('<bucket>', 'Bucket name or ID')
  .option('--effective', 'Also print the effective policy: the custom statements merged with the ones the platform manages')
  .action(async (reference: string, opts: { effective?: boolean }) => {
    const api = await ApiClient.create();
    const bucket = await resolveBucket(api, reference);

    const policy = await policyApi(
      () => api.get<BucketPolicy>(policyPath(bucket.id)),
      { bucket: bucket.name, needs: 'read' },
    );

    if (isJsonMode()) {
      jsonOutput(policy);
      return;
    }

    printPolicy(bucket.name, policy, opts.effective === true);
  });

// --- policy set --------------------------------------------------------------

interface SetOptions extends WaitFlags {
  file?: string;
  statements?: string;
  clear?: boolean;
  force?: boolean;
  yes?: boolean;
}

/**
 * The statements to store, from the one source the person named. All of it is
 * read and checked before any API call: a file that is not JSON must cost
 * nothing.
 */
async function statementsFrom(opts: SetOptions): Promise<BucketPolicyStatement[]> {
  const given = [
    opts.file !== undefined ? '--file' : null,
    opts.statements !== undefined ? '--statements' : null,
    opts.clear ? '--clear' : null,
  ].filter((flag): flag is string => flag !== null);

  if (given.length === 0) {
    throw new UsageError("Say what the custom statements should be: --file <path> (or - for the standard input), --statements '<json>', or --clear to remove them all.");
  }

  if (given.length > 1) {
    throw new UsageError(`Use only one of --file, --statements and --clear (got ${given.join(' and ')}).`);
  }

  if (opts.clear) return [];

  if (opts.statements !== undefined) return parsePolicyStatements(opts.statements, '--statements');

  const source = opts.file!;

  return parsePolicyStatements(await readInput(source), source === STDIN_SOURCE ? 'the standard input' : `--file ${source}`);
}

const setCommand = new Command('set')
  .description("Replace a bucket's custom policy statements: give --file, --statements or --clear")
  .argument('<bucket>', 'Bucket name or ID')
  .option('--file <path>', 'Read the statements from a JSON file: a list, or a policy document. - reads the standard input')
  .option('--statements <json>', 'The statements as JSON: a list, or a policy document')
  .option('--clear', 'Remove every custom statement (use instead of --file and --statements)')
  .option('-f, --force', 'Skip confirmation')
  .option('-y, --yes', 'Alias for --force')
  .option('--wait', 'Wait until the change is no longer being applied')
  .option('--wait-timeout <seconds>', 'How long --wait waits, in seconds or as 90s, 2m, 1h (default 60)')
  .action(async (reference: string, opts: SetOptions) => {
    const ceilingMs = waitCeiling(opts);
    const statements = await statementsFrom(opts);

    const api = await ApiClient.create();
    const bucket = await resolveBucket(api, reference);

    const proceed = await confirmDestruction(
      `replacing the custom policy statements of bucket ${bucket.name}`,
      statements.length === 0
        ? `Remove ALL custom policy statements of bucket ${bucket.name}?`
        : `Replace the custom policy statements of bucket ${bucket.name} with ${plural(statements.length, 'statement')}? Every statement stored now is removed.`,
      opts.force || opts.yes,
    );
    if (!proceed) {
      console.log('Cancelled.');
      return;
    }

    const accepted = await sending('Saving the policy...', () =>
      policyApi(
        () => api.put<BucketPolicy>(policyPath(bucket.id), { custom_policy_statements: statements }),
        { bucket: bucket.name, needs: 'write' },
      ),
    );

    await finishChange({
      api,
      bucket,
      accepted,
      ceilingMs,
      describe: () => console.log(
        statements.length === 0
          ? `Removed all custom statements from bucket ${bucket.name}.`
          : `Saved ${plural(statements.length, 'custom statement')} for bucket ${bucket.name}.`,
      ),
    });
  });

// --- policy grant ------------------------------------------------------------

interface GrantOptions extends WaitFlags {
  key?: string;
  folder?: string;
  wholeBucket?: boolean;
  level?: string;
}

interface GrantRequest {
  key: string;
  level: StorageKeyLevel;
  /** `null` for the whole bucket, which has to be asked for. */
  folder: string | null;
}

/** The folder as the API reads it: no surrounding spaces, no slashes at either end. */
const isEmptyFolder = (folder: string): boolean => folder.trim().replace(/^\/+|\/+$/g, '') === '';

/**
 * What a grant is for, checked before anything is sent. The whole bucket is
 * never inferred: an empty folder is an error, not the whole bucket by omission.
 */
function readGrantFlags(opts: GrantOptions): GrantRequest {
  const missing = [opts.key === undefined ? '--key' : null, opts.level === undefined ? '--level' : null]
    .filter((flag): flag is string => flag !== null);

  if (missing.length > 0) throw new MissingFlagsError(missing);

  const level = parseKeyLevel(opts.level!, '--level');

  if (opts.folder !== undefined && opts.wholeBucket) {
    throw new UsageError('Use either --folder <path> or --whole-bucket, not both.');
  }

  if (opts.folder === undefined && !opts.wholeBucket) {
    throw new UsageError('Say where the key gets access: --folder <path>, or --whole-bucket for the whole bucket.');
  }

  if (opts.folder !== undefined && isEmptyFolder(opts.folder)) {
    throw new UsageError('The folder is empty. To give access to the whole bucket, ask for it with --whole-bucket.');
  }

  return { key: opts.key!, level, folder: opts.wholeBucket ? null : opts.folder! };
}

function describeGrant(bucket: StorageBucket, key: StorageAccessKey, request: GrantRequest, granted: BucketPolicyGrant): void {
  const added = granted.added_statements.length;

  console.log(
    added === 0
      ? `Nothing to add: the policy of bucket ${bucket.name} already allows this.`
      : `Added ${plural(added, 'statement')} to the policy of bucket ${bucket.name}.`,
  );
  printDetails([
    ['Key', `${key.name} (${key.id})`],
    ['Where', request.folder === null ? 'the whole bucket' : `folder ${request.folder}`],
    ['Level', request.level],
  ]);

  for (const warning of granted.warnings) console.error(chalk.yellow(`Warning: ${warning}`));
}

const grantCommand = new Command('grant')
  .description('Give an access key access to a folder of a bucket, or to the whole bucket')
  .argument('<bucket>', 'Bucket name or ID')
  .option('--key <key>', "Required. The access key: its id, its S3 access key id or its name ('danube storage keys ls' lists them)")
  .option('--folder <path>', 'The folder to give access to, such as invoices or reports/2026 (this or --whole-bucket)')
  .option('--whole-bucket', 'Give access to the whole bucket instead of a folder (never inferred: an empty folder is refused)')
  .option('--level <level>', 'Required. What the key may do with the objects: read, readwrite (also add and overwrite) or full (also delete)')
  .option('--wait', 'Wait until the change is no longer being applied')
  .option('--wait-timeout <seconds>', 'How long --wait waits, in seconds or as 90s, 2m, 1h (default 60)')
  .action(async (reference: string, opts: GrantOptions) => {
    const request = readGrantFlags(opts);
    const ceilingMs = waitCeiling(opts);

    const api = await ApiClient.create();
    const bucket = await resolveBucket(api, reference);
    const key = await resolveAccessKey(api, request.key);

    // `key_id` is the key's own id, never its S3 access key id; and either
    // `folder` or `whole_bucket`, never both and never neither.
    const body = request.folder === null
      ? { key_id: key.id, whole_bucket: true, level: request.level }
      : { key_id: key.id, folder: request.folder, level: request.level };

    const granted = await sending('Adding the grant to the policy...', () =>
      policyApi(
        () => api.post<BucketPolicyGrant>(folderGrantsPath(bucket.id), body),
        { bucket: bucket.name, needs: 'write' },
      ),
    );

    await finishChange({ api, bucket, accepted: granted, ceilingMs, describe: () => describeGrant(bucket, key, request, granted) });
  });

export const policyCommand = new Command('policy')
  .description("Manage a bucket's policy: who can reach it, and what they may do")
  .addCommand(getCommand)
  .addCommand(setCommand)
  .addCommand(grantCommand);
