import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setJsonMode } from '../../../src/lib/json-mode.js';

const mockGet = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: { create: () => Promise.resolve({ get: mockGet }) },
}));

const { caCertificateCommand } = await import('../../../src/commands/database/ca-certificate.js');

const certificate = {
  ca_certificate: '-----BEGIN CERTIFICATE-----\npublic-ca\n-----END CERTIFICATE-----\n',
  expires_at: '2036-10-23T00:00:00+00:00',
  fingerprint_sha256: 'a'.repeat(64),
};

describe('database ca-certificate', () => {
  let directory: string;
  let stdout: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'danube-ca-'));
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    setJsonMode(false);
    mockGet.mockReset();
    mockGet.mockResolvedValueOnce({ data: [{ id: 'db-1', name: 'my-db' }] })
      .mockResolvedValueOnce({ success: true, data: certificate });
    caCertificateCommand.setOptionValue('output', undefined);
  });

  afterEach(async () => {
    setJsonMode(false);
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('resolves a database by name and prints only its public CA PEM', async () => {
    await caCertificateCommand.parseAsync(['node', 'test', 'my-db']);

    expect(mockGet).toHaveBeenLastCalledWith('/api/v1/database/db-1/ca-certificate');
    expect(stdout).toHaveBeenCalledExactlyOnceWith(certificate.ca_certificate);
    expect(log).not.toHaveBeenCalled();
  });

  it('emits the certificate and metadata in the standard JSON envelope', async () => {
    setJsonMode(true);

    await caCertificateCommand.parseAsync(['node', 'test', 'db-1']);

    expect(JSON.parse(log.mock.calls[0]![0])).toEqual({ success: true, data: certificate, error: null, meta: {} });
    expect(stdout).not.toHaveBeenCalled();
  });

  it('writes exactly the PEM to an explicitly requested file', async () => {
    const path = join(directory, 'ca.pem');

    await caCertificateCommand.parseAsync(['node', 'test', 'db-1', '--output', path]);

    expect(await readFile(path, 'utf8')).toBe(certificate.ca_certificate);
    expect(stdout).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(`CA certificate saved to ${path}`);
  });

  it('preserves an existing output file', async () => {
    const path = join(directory, 'ca.pem');
    await writeFile(path, 'existing');

    await expect(caCertificateCommand.parseAsync(['node', 'test', 'db-1', '--output', path]))
      .rejects.toMatchObject({ code: 'EEXIST' });

    expect(await readFile(path, 'utf8')).toBe('existing');
  });

  it('refuses to follow an output symlink', async () => {
    const target = join(directory, 'existing.pem');
    const path = join(directory, 'ca.pem');
    await writeFile(target, 'existing');
    await symlink(target, path);

    await expect(caCertificateCommand.parseAsync(['node', 'test', 'db-1', '--output', path]))
      .rejects.toMatchObject({ code: 'EEXIST' });

    expect(await readFile(target, 'utf8')).toBe('existing');
  });

  it('keeps JSON output machine-readable when saving a file', async () => {
    const path = join(directory, 'ca.pem');
    setJsonMode(true);

    await caCertificateCommand.parseAsync(['node', 'test', 'db-1', '--output', path]);

    expect(await readFile(path, 'utf8')).toBe(certificate.ca_certificate);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0]).data).toEqual(certificate);
  });

  it('does not create an output file when the API refuses the request', async () => {
    const path = join(directory, 'ca.pem');
    mockGet.mockReset();
    mockGet.mockResolvedValueOnce({ data: [{ id: 'db-1', name: 'my-db' }] })
      .mockRejectedValueOnce(new Error('CA certificate is not available'));

    await expect(caCertificateCommand.parseAsync(['node', 'test', 'db-1', '--output', path]))
      .rejects.toThrow('CA certificate is not available');
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
