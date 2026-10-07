import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client.js';
import { resolveResource } from '../../lib/resolve.js';
import { isJsonMode, jsonEnvelope } from '../../lib/json-mode.js';
import { canPrompt, confirmDestruction } from '../../lib/interactive.js';
import { printDetails, statusColor } from '../../lib/output.js';
import { ConfirmationRequiredError, MissingFlagsError, UsageError } from '../../lib/errors.js';
import { readInput, STDIN_SOURCE } from '../../lib/read-input.js';
import { refuseRepeatedFlags, singleValue } from '../../lib/single-value-flag.js';
import { parseKeyLevel, resolveAccessKey } from '../../lib/storage-keys.js';
import {
  policyApi,
  parsePolicyStatements,
  policyPath,
  folderGrantsPath,
  POLICY_UPDATING,
  type PolicyCall,
} from '../../lib/bucket-policy.js';
import { finishChange, waitCeiling, type WaitFlags } from '../../lib/policy-change.js';
import type {
  BucketPolicy,
  BucketPolicyGrant,
  BucketPolicyStatement,
  StorageAccessKey,
  StorageBucket,
  StorageKeyLevel,
} from '../../types/api.js';

/**
 * A bucket by its exact name, slug or full id. These commands decide who may
 * reach a bucket, so a name that is not a bucket's name must not land on the
 * bucket whose id happens to begin with it.
 */
const resolveBucket = (api: ApiClient, reference: string): Promise<StorageBucket> =>
  resolveResource<StorageBucket>(api, '/api/v1/storage/buckets', 'bucket', reference, { exact: true });

const callOn = (bucket: StorageBucket, needs: PolicyCall['needs']): PolicyCall => ({
  bucket: bucket.name,
  needs,
  provider: bucket.provider,
});

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

    const policy = await policyApi(() => api.get<BucketPolicy>(policyPath(bucket.id)), callOn(bucket, 'read'));

    if (isJsonMode()) {
      jsonEnvelope(policy, { meta: { bucket_id: bucket.id } });
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

/** Where the statements come from, before any of them is read. */
type StatementsSource =
  | { kind: 'clear' }
  | { kind: 'inline'; text: string }
  | { kind: 'file'; path: string };

/** The one source the person named: not none, and not several. */
function sourceOf(opts: SetOptions): StatementsSource {
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

  if (opts.clear) return { kind: 'clear' };

  return opts.statements !== undefined ? { kind: 'inline', text: opts.statements } : { kind: 'file', path: opts.file! };
}

/**
 * Refuses, before anything is read or sent, a replacement that nobody can be
 * asked about. A person is asked at a terminal; a script has to say `--yes`. And
 * the standard input is no place to ask from when it also carries the
 * statements: it has been read to its end by then, so at a terminal the person
 * would type the whole policy and meet a question that cannot be answered.
 */
function requireAnAnswerableConfirmation(source: StatementsSource, opts: SetOptions, reference: string): void {
  if (opts.force || opts.yes) return;

  const what = `replacing the custom policy statements of bucket ${reference}`;

  if (source.kind === 'file' && source.path === STDIN_SOURCE) {
    throw new ConfirmationRequiredError(
      what,
      'the statements come from the standard input, so there is nothing left to answer a confirmation on. Add --yes (or --force) to go ahead.',
    );
  }

  if (!canPrompt()) throw new ConfirmationRequiredError(what);
}

/**
 * The statements to store. An empty list is refused: it removes every custom
 * statement, and `--yes` would let a filter that selected nothing do that
 * without anyone asking. Removing them all is `--clear`.
 */
async function loadStatements(source: StatementsSource): Promise<BucketPolicyStatement[]> {
  if (source.kind === 'clear') return [];

  const statements = source.kind === 'inline'
    ? parsePolicyStatements(source.text, '--statements')
    : parsePolicyStatements(await readInput(source.path), source.path === STDIN_SOURCE ? 'the standard input' : `--file ${source.path}`);

  if (statements.length === 0) {
    throw new UsageError('The list is empty, which removes every custom statement; use --clear to do that on purpose.');
  }

  return statements;
}

const setCommand = new Command('set')
  .description("Replace a bucket's custom policy statements: give --file, --statements or --clear")
  .argument('<bucket>', 'Bucket name or ID')
  .option('--file <path>', 'Read the statements from a JSON file: a list, or a policy document. - reads the standard input (and needs --yes)', singleValue('--file'))
  .option('--statements <json>', 'The statements as JSON: a list, or a policy document', singleValue('--statements'))
  .option('--clear', 'Remove every custom statement (use instead of --file and --statements)')
  .option('-f, --force', 'Skip confirmation')
  .option('-y, --yes', 'Alias for --force')
  .option('--wait', 'Wait until the change is no longer being applied')
  .option('--wait-timeout <seconds>', 'How long --wait waits, in seconds or as 90s, 2m, 1h (default 60)', singleValue('--wait-timeout'))
  .hook('preAction', refuseRepeatedFlags)
  .action(async (reference: string, opts: SetOptions) => {
    // All of it is checked, and read, before the API is asked anything.
    const ceilingMs = waitCeiling(opts);
    const source = sourceOf(opts);
    requireAnAnswerableConfirmation(source, opts, reference);
    const statements = await loadStatements(source);

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
        callOn(bucket, 'write'),
      ),
    );

    await finishChange({
      api,
      bucket,
      accepted,
      ceilingMs,
      meta: { bucket_id: bucket.id },
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

  // This command never asks for what is missing, so it is not "non-interactive mode".
  if (missing.length > 0) throw new MissingFlagsError(missing, { promptable: false });

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

/** Whether a statement names this ARN among its principals (`{AWS: [arn, ...]}` or `{AWS: arn}`). */
function namesPrincipal(statement: BucketPolicyStatement, arn: string): boolean {
  const principal = statement.Principal;
  if (typeof principal !== 'object' || principal === null) return false;

  const aws = (principal as { AWS?: unknown }).AWS;

  return Array.isArray(aws) ? aws.includes(arn) : aws === arn;
}

/**
 * How many statements the key already had, besides the ones this grant added. A
 * grant only adds: a key holding `full` on a folder that is granted `read` there
 * keeps `full`. Nothing is counted when nothing was added — the statements found
 * are then the grant being asked for again, not other access.
 */
function otherStatementsFor(key: StorageAccessKey, added: BucketPolicyStatement[], stored: BucketPolicyStatement[]): number {
  const arn = key.arn;
  if (!arn || added.length === 0) return 0;

  const justAdded = new Set(added.map((statement) => JSON.stringify(statement)));

  return stored.filter((statement) => !justAdded.has(JSON.stringify(statement)) && namesPrincipal(statement, arn)).length;
}

function describeGrant(bucket: StorageBucket, key: StorageAccessKey, request: GrantRequest, granted: BucketPolicyGrant | null): void {
  // The grant is applied by now: an answer with less than it should say is not a crash.
  const addedList = granted?.added_statements;
  const added = Array.isArray(addedList) ? addedList : null;

  if (added === null) {
    console.log('The grant was accepted, but the answer did not say what was added.');
  } else {
    console.log(
      added.length === 0
        ? `Nothing to add: the policy of bucket ${bucket.name} already allows this.`
        : `Added ${plural(added.length, 'statement')} to the policy of bucket ${bucket.name}.`,
    );
  }

  printDetails([
    ['Key', `${key.name} (${key.id})`],
    ['Where', request.folder === null ? 'the whole bucket' : `folder ${request.folder}`],
    ['Level', request.level],
  ]);

  for (const warning of granted?.warnings ?? []) console.error(chalk.yellow(`Warning: ${warning}`));

  const others = otherStatementsFor(key, added ?? [], granted?.custom_policy_statements ?? []);
  if (others > 0) {
    console.error(chalk.yellow(
      `This key has ${plural(others, 'other statement')} in the policy; a grant only adds. To narrow its access replace the custom statements: danube storage policy set ${bucket.name}.`,
    ));
  }
}

const grantCommand = new Command('grant')
  .description('Give an access key access to a folder of a bucket, or to the whole bucket')
  .argument('<bucket>', 'Bucket name or ID')
  .option('--key <key>', "Required. The access key: its id, its S3 access key id or its name ('danube storage keys ls' lists them)", singleValue('--key'))
  .option('--folder <path>', 'The folder to give access to, such as invoices or reports/2026 (this or --whole-bucket)', singleValue('--folder'))
  .option('--whole-bucket', 'Give access to the whole bucket instead of a folder (never inferred: an empty folder is refused)')
  .option('--level <level>', 'Required. What the key may do with the objects: read, readwrite (also add and overwrite) or full (also delete)', singleValue('--level'))
  .option('--wait', 'Wait until the change is no longer being applied')
  .option('--wait-timeout <seconds>', 'How long --wait waits, in seconds or as 90s, 2m, 1h (default 60)', singleValue('--wait-timeout'))
  .hook('preAction', refuseRepeatedFlags)
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
      policyApi(() => api.post<BucketPolicyGrant>(folderGrantsPath(bucket.id), body), callOn(bucket, 'write')),
    );

    await finishChange({
      api,
      bucket,
      accepted: granted,
      ceilingMs,
      meta: { bucket_id: bucket.id, key_id: key.id },
      describe: () => describeGrant(bucket, key, request, granted),
    });
  });

export const policyCommand = new Command('policy')
  .description("Manage a bucket's policy: who can reach it, and what they may do")
  .addCommand(getCommand)
  .addCommand(setCommand)
  .addCommand(grantCommand);
