import { createReadStream } from 'node:fs';
import { open, rm, writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { ApiClient } from '../../lib/api-client.js';
import { ApiError, ConfirmationRequiredError, MissingFlagsError, UsageError } from '../../lib/errors.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import { resolveResource } from '../../lib/resolve.js';
import { refuseRepeatedFlags, singleValue } from '../../lib/single-value-flag.js';
import type { DatabaseInstance } from '../../types/api.js';

interface CaIdentity { fingerprint_sha256: string; expires_at: string }
interface PendingCa extends CaIdentity { id: string; mode: string; ca_certificate: string; trust_bundle: string }
interface TlsStatus {
  revision: number;
  mode: string;
  active: CaIdentity | null;
  previous: (CaIdentity & { mode: string }) | null;
  pending: PendingCa | null;
  operation: { id: string; phase: string; error_code: string | null } | null;
}
interface StageOptions {
  expectedRevision?: string; mode?: string; caCertificateFile?: string; caPrivateKeyFile?: string; output?: string;
}
interface ChangeOptions { expectedRevision?: string; stageId?: string; fingerprint?: string; clientsTrustCa?: boolean }
type Response = { success: true; data: TlsStatus };

function required(value: string | undefined, flag: string): string {
  if (!value) throw new MissingFlagsError([flag], { promptable: false });
  return value;
}

function expectedRevision(value?: string): number {
  const revision = required(value, '--expected-revision');
  if (!/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision))) {
    throw new UsageError('--expected-revision must be a non-negative integer from tls status.');
  }
  return Number(revision);
}

function stageId(value?: string): string {
  const id = required(value, '--stage-id');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new UsageError('--stage-id must be the UUID from tls status.');
  }
  return id;
}

function trustAcknowledgement(opts: ChangeOptions): { fingerprint_sha256: string; clients_trust_ca: true } {
  const fingerprint = required(opts.fingerprint, '--fingerprint');
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new UsageError('--fingerprint must be 64 lowercase hexadecimal characters from tls status.');
  if (!opts.clientsTrustCa) throw new ConfirmationRequiredError('CA change', 'pass --clients-trust-ca only after updating every client trust store');
  return { fingerprint_sha256: fingerprint, clients_trust_ca: true };
}

async function tlsResource(reference: string): Promise<{ api: ApiClient; path: string }> {
  const api = await ApiClient.create();
  const instance = await resolveResource<DatabaseInstance>(api, '/api/v1/database', 'database', reference, { exact: true });
  return { api, path: `/api/v1/database/${instance.id}/tls` };
}

function printStatus(status: TlsStatus): void {
  // Only public fields belong in terminal output, even if an API adds secret fields later.
  const identity = (ca: CaIdentity) => ({ fingerprint_sha256: ca.fingerprint_sha256, expires_at: ca.expires_at });
  const data = {
    revision: status.revision, mode: status.mode,
    active: status.active ? identity(status.active) : null,
    previous: status.previous ? { ...identity(status.previous), mode: status.previous.mode } : null,
    pending: status.pending ? { ...identity(status.pending), id: status.pending.id, mode: status.pending.mode,
      ca_certificate: status.pending.ca_certificate, trust_bundle: status.pending.trust_bundle } : null,
    operation: status.operation ? { id: status.operation.id, phase: status.operation.phase, error_code: status.operation.error_code } : null,
  };
  if (isJsonMode()) jsonOutput(data);
  else console.log(JSON.stringify(data, null, 2));
}

function pendingBundle(status: TlsStatus): string {
  if (!status.pending?.trust_bundle) throw new UsageError('No pending CA trust bundle is available.');
  return status.pending.trust_bundle;
}

async function readPem(path: string, flag: string): Promise<string> {
  if (path === '-') throw new UsageError(`${flag} requires an explicit file path.`);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of createReadStream(path)) {
      size += chunk.length;
      if (size > 65536) throw new UsageError(`${flag} must contain 1–65536 bytes of PEM.`);
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`Cannot read the file supplied by ${flag}.`);
  }
  if (size === 0) throw new UsageError(`${flag} must contain 1–65536 bytes of PEM.`);
  return Buffer.concat(chunks).toString('utf8');
}

async function stageBody(opts: StageOptions): Promise<Record<string, unknown>> {
  const expected_revision = expectedRevision(opts.expectedRevision);
  if (opts.mode !== 'managed' && opts.mode !== 'byo') throw new UsageError('--mode must be managed or byo.');
  if (opts.mode === 'managed') {
    if (opts.caCertificateFile || opts.caPrivateKeyFile) throw new UsageError('BYO file flags cannot be used with managed mode.');
    return { mode: opts.mode, expected_revision };
  }
  const certificatePath = required(opts.caCertificateFile, '--ca-certificate-file');
  const keyPath = required(opts.caPrivateKeyFile, '--ca-private-key-file');
  return { mode: opts.mode, expected_revision,
    ca_certificate: await readPem(certificatePath, '--ca-certificate-file'),
    ca_private_key: await readPem(keyPath, '--ca-private-key-file') };
}

async function stageCa(api: ApiClient, path: string, body: Record<string, unknown>, output?: string): Promise<TlsStatus> {
  const file = output ? await open(output, 'wx', 0o600) : null;
  try {
    let res: Response;
    try { res = await api.post<Response>(`${path}/ca/stage`, body); }
    catch (error) {
      if (body.mode !== 'byo') throw error;
      const message = 'CA staging failed. Check tls status before retrying; private-key error details are suppressed.';
      throw error instanceof ApiError ? new ApiError(error.statusCode, message) : new Error(message);
    }
    if (file) await file.writeFile(pendingBundle(res.data));
    return res.data;
  } catch (error) {
    if (file) await rm(output!);
    throw error;
  } finally { await file?.close(); }
}

function changeCommand(name: string, description: string): Command {
  return new Command(name).description(description)
    .argument('<name-or-id>', 'Exact database instance name or ID')
    .option('--expected-revision <revision>', 'Revision from tls status', singleValue('--expected-revision'))
    .hook('preAction', refuseRepeatedFlags);
}

const statusCommand = new Command('status')
  .description('Show public TLS status, pending CA and the current revision')
  .argument('<name-or-id>', 'Exact database instance name or ID')
  .option('--output <path>', 'Save the pending public trust bundle to a new file')
  .action(async (reference: string, opts: { output?: string }) => {
    const { api, path } = await tlsResource(reference);
    const res = await api.get<Response>(path);
    if (opts.output) await writeFile(opts.output, pendingBundle(res.data), { flag: 'wx', mode: 0o600 });
    printStatus(res.data);
  });

const stageCommand = changeCommand('ca-stage', 'Stage a managed or BYO CA without activating it')
  .option('--mode <mode>', 'managed or byo', singleValue('--mode'))
  .option('--ca-certificate-file <path>', 'BYO public CA PEM file', singleValue('--ca-certificate-file'))
  .option('--ca-private-key-file <path>', 'BYO private key PEM file (never printed)', singleValue('--ca-private-key-file'))
  .option('--output <path>', 'Save the pending public trust bundle to a new file', singleValue('--output'))
  .action(async (reference: string, opts: StageOptions) => {
    const body = await stageBody(opts);
    const { api, path } = await tlsResource(reference);
    printStatus(await stageCa(api, path, body, opts.output));
  });

const cancelCommand = changeCommand('ca-cancel', 'Cancel a specific pending CA stage')
  .option('--stage-id <uuid>', 'Pending stage ID from tls status', singleValue('--stage-id'))
  .action(async (reference: string, opts: ChangeOptions) => {
    const body = { expected_revision: expectedRevision(opts.expectedRevision), stage_id: stageId(opts.stageId) };
    const { api, path } = await tlsResource(reference);
    printStatus((await api.delete<Response>(`${path}/ca/stage`, body)).data);
  });

const activateCommand = changeCommand('ca-activate', 'Activate a reviewed pending CA after every client trusts it')
  .option('--stage-id <uuid>', 'Pending stage ID from tls status', singleValue('--stage-id'))
  .option('--fingerprint <sha256>', 'Pending CA SHA-256 fingerprint from tls status', singleValue('--fingerprint'))
  .option('--clients-trust-ca', 'Acknowledge every client already trusts the pending CA')
  .action(async (reference: string, opts: ChangeOptions) => {
    const body = { expected_revision: expectedRevision(opts.expectedRevision), stage_id: stageId(opts.stageId), ...trustAcknowledgement(opts) };
    const { api, path } = await tlsResource(reference);
    printStatus((await api.post<Response>(`${path}/ca/activate`, body)).data);
  });

const rollbackCommand = changeCommand('ca-rollback', 'Restore the previous CA after every client trusts it')
  .option('--fingerprint <sha256>', 'Previous CA SHA-256 fingerprint', singleValue('--fingerprint'))
  .option('--clients-trust-ca', 'Acknowledge every client trusts the previous CA')
  .action(async (reference: string, opts: ChangeOptions) => {
    const body = { expected_revision: expectedRevision(opts.expectedRevision), ...trustAcknowledgement(opts) };
    const { api, path } = await tlsResource(reference);
    printStatus((await api.post<Response>(`${path}/ca/rollback`, body)).data);
  });

export const tlsCommand = new Command('tls').description('Manage PostgreSQL CA trust and guarded rotation')
  .addCommand(statusCommand).addCommand(stageCommand).addCommand(cancelCommand)
  .addCommand(activateCommand).addCommand(rollbackCommand);
