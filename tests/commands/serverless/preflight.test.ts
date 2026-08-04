import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: { create: () => Promise.resolve({ get: mockGet }) },
}));

const { preflightCommand } = await import('../../../src/commands/serverless/preflight.js');
const { setJsonMode } = await import('../../../src/lib/json-mode.js');

const preflight = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    image: 'cr.danubedata.ro/safi4/danube-todo:v1.0.0',
    registry_host: 'cr.danubedata.ro',
    namespace: 'safi4',
    repository: 'safi4/danube-todo',
    reference: 'v1.0.0',
    in_namespace: true,
    external: false,
    credential: { scope: 'push_pull', keys: 1, push_capable: true },
    manifest: {
      exists: true, digest: 'sha256:abc', media_type: 'application/vnd.oci.image.index.v1+json',
      size_bytes: 1024, architectures: ['linux/amd64'], reachable: true, error: null,
    },
    quota: {},
    can_pull: true,
    findings: [],
    ...over,
  },
  error: null,
  meta: { cluster_architecture: 'amd64' },
});

const run = (args: string[]) => preflightCommand.parseAsync(['node', 'test', ...args]);

describe('rapids preflight', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  const printed = () => JSON.parse(logSpy.mock.calls.at(-1)![0] as string);

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGet.mockReset();
    process.exitCode = undefined;
  });

  afterEach(() => {
    setJsonMode(false);
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('passes a deployable image through with its digest and architectures', async () => {
    mockGet.mockResolvedValue(preflight());

    setJsonMode(true);
    await run(['--image', 'cr.danubedata.ro/safi4/danube-todo:v1.0.0']);

    const payload = printed();
    expect(payload.success).toBe(true);
    expect(payload.data.can_pull).toBe(true);
    expect(payload.data.manifest.digest).toBe('sha256:abc');
    expect(process.exitCode).toBeUndefined();
  });

  it('exits non-zero when the image definitely cannot be pulled', async () => {
    mockGet.mockResolvedValue(preflight({
      can_pull: false,
      findings: [{ code: 'registry.manifest_not_found', severity: 'fatal', summary: 'x', remediation: 'y', retryable: false }],
    }));

    setJsonMode(true);
    await run(['--image', 'cr.danubedata.ro/safi4/danube-todo:nope']);

    expect(process.exitCode).toBe(1);
  });

  it('does not fail the command when pullability is merely unknown', async () => {
    // An image in a registry we cannot read is not evidence of a broken
    // deploy — exiting 1 here would block every Docker Hub image.
    mockGet.mockResolvedValue(preflight({ can_pull: null, external: true }));

    setJsonMode(true);
    await run(['--image', 'nginx:latest']);

    expect(printed().data.can_pull).toBeNull();
    expect(process.exitCode).toBeUndefined();
  });

  it('url-encodes the reference so a digest survives the query string', async () => {
    mockGet.mockResolvedValue(preflight());

    setJsonMode(true);
    await run(['--image', 'cr.danubedata.ro/safi4/app@sha256:abc']);

    expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('%40sha256%3Aabc'));
  });

  it('requires --image rather than guessing one', async () => {
    await expect(run([])).rejects.toThrow(/--image/);
  });
});
