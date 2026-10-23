import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../src/lib/errors.js';
import { setJsonMode } from '../../../src/lib/json-mode.js';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockDelete = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: { create: () => Promise.resolve({ get: mockGet, post: mockPost, delete: mockDelete }) },
}));
const { tlsCommand } = await import('../../../src/commands/database/tls.js');

const stageId = '12345678-1234-4123-8123-123456789012';
const fingerprint = 'a'.repeat(64);
const status = { revision: 2, mode: 'managed', active: null, previous: null, pending: {
  id: stageId, mode: 'managed', fingerprint_sha256: fingerprint,
  expires_at: '2036-10-23T00:00:00Z', ca_certificate: 'NEW PUBLIC CA', trust_bundle: 'OLD AND NEW PUBLIC CAs',
}, operation: null };
const run = (...args: string[]) => tlsCommand.parseAsync(['node', 'test', ...args]);
const revision = ['--expected-revision', '1'];
const identity = ['--stage-id', stageId, '--fingerprint', fingerprint];

describe('database TLS CA lifecycle', () => {
  let directory: string;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'danube-tls-'));
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    setJsonMode(false);
    mockGet.mockReset().mockResolvedValueOnce({ data: [{ id: 'db-1', name: 'my-db' }] })
      .mockResolvedValueOnce({ success: true, data: status });
    mockPost.mockReset().mockResolvedValue({ success: true, data: status });
    mockDelete.mockReset().mockResolvedValue({ success: true, data: status });
    for (const command of tlsCommand.commands) {
      for (const key of Object.keys(command.opts())) command.setOptionValue(key, undefined);
    }
  });

  afterEach(async () => {
    setJsonMode(false);
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('shows the public status through the standard JSON envelope', async () => {
    setJsonMode(true);
    await run('status', 'my-db');
    expect(mockGet).toHaveBeenLastCalledWith('/api/v1/database/db-1/tls');
    expect(JSON.parse(log.mock.calls[0]![0])).toEqual({ success: true, data: status, error: null, meta: {} });
  });

  it('stages a managed CA without activating it and exports the public trust bundle', async () => {
    const path = join(directory, 'trust.pem');
    await run('ca-stage', 'my-db', '--mode', 'managed', ...revision, '--output', path);
    expect(mockPost).toHaveBeenCalledExactlyOnceWith('/api/v1/database/db-1/tls/ca/stage', {
      mode: 'managed', expected_revision: 1,
    });
    expect(await readFile(path, 'utf8')).toBe(status.pending.trust_bundle);
    expect(log.mock.calls[0]![0]).toContain(fingerprint);
  });

  it('reads BYO certificate and key only from explicit files without printing the key', async () => {
    const certificatePath = join(directory, 'ca.pem');
    const keyPath = join(directory, 'ca.key');
    await writeFile(certificatePath, 'PUBLIC CA');
    await writeFile(keyPath, 'PRIVATE KEY');
    await run('ca-stage', 'db-1', '--mode', 'byo', ...revision,
      '--ca-certificate-file', certificatePath, '--ca-private-key-file', keyPath);
    expect(mockPost).toHaveBeenCalledWith('/api/v1/database/db-1/tls/ca/stage', {
      mode: 'byo', expected_revision: 1, ca_certificate: 'PUBLIC CA', ca_private_key: 'PRIVATE KEY',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE KEY');
  });

  it('redacts BYO API errors, including validation details that echo the key', async () => {
    const certificatePath = join(directory, 'ca.pem');
    const keyPath = join(directory, 'ca.key');
    await writeFile(certificatePath, 'PUBLIC CA');
    await writeFile(keyPath, 'PRIVATE KEY');
    mockPost.mockRejectedValue(new ApiError(422, 'PRIVATE KEY', { ca_private_key: ['PRIVATE KEY'] }));
    const error = await run('ca-stage', 'db-1', '--mode', 'byo', ...revision,
      '--ca-certificate-file', certificatePath, '--ca-private-key-file', keyPath).catch(error => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.statusCode).toBe(422);
    expect(error.message).toContain('CA staging failed');
    expect(JSON.stringify(error)).not.toContain('PRIVATE KEY');
    expect(error.message).not.toContain('PRIVATE KEY');
  });

  it.each(['ca-stage', 'ca-cancel', 'ca-activate', 'ca-rollback'])('requires an explicit revision for %s', async command => {
    await expect(run(command, 'my-db')).rejects.toThrow('--expected-revision');
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it.each(['-1', '1.5', 'abc', '9007199254740992'])('refuses invalid revision %s before a request', async value => {
    await expect(run('ca-stage', 'db-1', '--mode', 'managed', '--expected-revision', value)).rejects.toThrow('non-negative integer');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it.each(['ca-activate', 'ca-rollback'])('requires explicit client trust acknowledgement for %s', async command => {
    const flags = command === 'ca-activate' ? identity : ['--fingerprint', fingerprint];
    await expect(run(command, 'db-1', ...revision, ...flags)).rejects.toThrow('--clients-trust-ca');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('activates exactly the reviewed stage with fingerprint and revision guards', async () => {
    await run('ca-activate', 'db-1', ...revision, ...identity, '--clients-trust-ca');
    expect(mockPost).toHaveBeenCalledExactlyOnceWith('/api/v1/database/db-1/tls/ca/activate', {
      expected_revision: 1, stage_id: stageId, fingerprint_sha256: fingerprint, clients_trust_ca: true,
    });
  });

  it('cancels exactly the reviewed pending stage using a guarded DELETE body', async () => {
    await run('ca-cancel', 'db-1', ...revision, '--stage-id', stageId);
    expect(mockDelete).toHaveBeenCalledWith('/api/v1/database/db-1/tls/ca/stage', { expected_revision: 1, stage_id: stageId });
  });

  it('rolls back only with explicit client trust and fingerprint guards', async () => {
    await run('ca-rollback', 'db-1', ...revision, '--fingerprint', fingerprint, '--clients-trust-ca');
    expect(mockPost).toHaveBeenCalledWith('/api/v1/database/db-1/tls/ca/rollback', {
      expected_revision: 1, fingerprint_sha256: fingerprint, clients_trust_ca: true,
    });
  });

  it('refuses managed mode with BYO file flags', async () => {
    await expect(run('ca-stage', 'db-1', ...revision, '--mode', 'managed', '--ca-private-key-file', 'key.pem'))
      .rejects.toThrow('BYO file flags');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('requires both BYO files', async () => {
    await expect(run('ca-stage', 'db-1', ...revision, '--mode', 'byo')).rejects.toThrow('--ca-certificate-file');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('does not expose file error paths or inline private key material', async () => {
    const error = await run('ca-stage', 'db-1', ...revision, '--mode', 'byo', '--ca-certificate-file', 'missing',
      '--ca-private-key-file', '-----BEGIN PRIVATE KEY-----').catch(error => error);
    expect(error.message).not.toContain('PRIVATE KEY');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('refuses to overwrite a public bundle file', async () => {
    const path = join(directory, 'bundle.pem');
    await writeFile(path, 'existing');
    await expect(run('ca-stage', 'db-1', ...revision, '--mode', 'managed', '--output', path)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path, 'utf8')).toBe('existing');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('exports the pending public trust bundle from status', async () => {
    const path = join(directory, 'bundle.pem');
    await run('status', 'db-1', '--output', path);
    expect(await readFile(path, 'utf8')).toBe(status.pending.trust_bundle);
  });

  it('allows status without a pending CA, and never prints unexpected private fields', async () => {
    setJsonMode(true);
    mockGet.mockReset().mockResolvedValueOnce({ data: [{ id: 'db-1', name: 'my-db' }] })
      .mockResolvedValueOnce({ success: true, data: { ...status, pending: null,
        active: { fingerprint_sha256: fingerprint, expires_at: '2036', ca_private_key: 'PRIVATE KEY' },
        operation: { id: 'op-1', phase: 'pending', error_code: null, ca_private_key: 'PRIVATE KEY' },
        ca_private_key: 'PRIVATE KEY' } });
    await run('status', 'db-1');
    const data = JSON.parse(log.mock.calls[0]![0]).data;
    expect(data.active).toEqual({ fingerprint_sha256: fingerprint, expires_at: '2036' });
    expect(data.operation).toEqual({ id: 'op-1', phase: 'pending', error_code: null });
    expect(data.pending).toBeNull();
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE KEY');
  });

  it('exposes only public previous CA metadata so the rollback fingerprint can be reviewed', async () => {
    setJsonMode(true);
    const previousFingerprint = 'b'.repeat(64);
    mockGet.mockReset().mockResolvedValueOnce({ data: [{ id: 'db-1', name: 'my-db' }] })
      .mockResolvedValueOnce({ success: true, data: { ...status,
        previous: { mode: 'byo', fingerprint_sha256: previousFingerprint, expires_at: '2035-10-23T00:00:00Z', ca_private_key: 'PRIVATE KEY' } } });

    await run('status', 'db-1');

    expect(JSON.parse(log.mock.calls[0]![0]).data.previous).toEqual({
      mode: 'byo', fingerprint_sha256: previousFingerprint, expires_at: '2035-10-23T00:00:00Z',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE KEY');
  });

  it('refuses bundle export without a pending CA', async () => {
    const path = join(directory, 'bundle.pem');
    mockGet.mockReset().mockResolvedValueOnce({ data: [{ id: 'db-1', name: 'my-db' }] })
      .mockResolvedValueOnce({ success: true, data: { ...status, pending: null } });
    await expect(run('status', 'db-1', '--output', path)).rejects.toThrow('No pending CA trust bundle');
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['bad', ''])('refuses invalid CA mode %s', async mode => {
    await expect(run('ca-stage', 'db-1', ...revision, '--mode', mode)).rejects.toThrow('--mode');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('refuses an invalid stage UUID before making requests', async () => {
    await expect(run('ca-cancel', 'db-1', ...revision, '--stage-id', 'invalid')).rejects.toThrow('UUID');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('refuses an invalid fingerprint before making requests', async () => {
    await expect(run('ca-rollback', 'db-1', ...revision, '--fingerprint', 'wrong', '--clients-trust-ca'))
      .rejects.toThrow('64 lowercase hexadecimal');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('requires the BYO key file even when a certificate file was supplied', async () => {
    await expect(run('ca-stage', 'db-1', ...revision, '--mode', 'byo', '--ca-certificate-file', 'ca.pem'))
      .rejects.toThrow('--ca-private-key-file');
  });

  it('refuses stdin as a BYO PEM source', async () => {
    await expect(run('ca-stage', 'db-1', ...revision, '--mode', 'byo', '--ca-certificate-file', '-', '--ca-private-key-file', '-'))
      .rejects.toThrow('explicit file path');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it.each([0, 65537])('refuses a BYO PEM file of %i bytes', async size => {
    const path = join(directory, 'ca.pem');
    await writeFile(path, Buffer.alloc(size));
    await expect(run('ca-stage', 'db-1', ...revision, '--mode', 'byo', '--ca-certificate-file', path, '--ca-private-key-file', path))
      .rejects.toThrow('1–65536 bytes');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('preserves managed API errors and removes the reserved output file', async () => {
    const path = join(directory, 'bundle.pem');
    mockPost.mockRejectedValue(new ApiError(409, 'Revision changed'));
    await expect(run('ca-stage', 'db-1', ...revision, '--mode', 'managed', '--output', path)).rejects.toThrow('Revision changed');
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('redacts non-API errors from BYO staging as well', async () => {
    const path = join(directory, 'ca.pem');
    await writeFile(path, 'PRIVATE KEY');
    mockPost.mockRejectedValue(new Error('PRIVATE KEY'));
    const error = await run('ca-stage', 'db-1', ...revision, '--mode', 'byo',
      '--ca-certificate-file', path, '--ca-private-key-file', path).catch(error => error);
    expect(error.message).toContain('CA staging failed');
    expect(error.message).not.toContain('PRIVATE KEY');
  });
});
