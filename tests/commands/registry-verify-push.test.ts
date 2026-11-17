import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
vi.mock('../../src/lib/api-client.js', () => ({
  ApiClient: { create: () => Promise.resolve({ get: mockGet }) },
}));

const mockCheck = vi.fn();
vi.mock('../../src/lib/docker-credentials.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/docker-credentials.js')>()),
  checkDockerPush: (...args: unknown[]) => mockCheck(...args),
}));

const { registryCommand } = await import('../../src/commands/registry/index.js');
const { setJsonMode } = await import('../../src/lib/json-mode.js');

const verify = (repo: string) => registryCommand.parseAsync(['verify-push', repo], { from: 'user' });

const permitted = (pushReference = 'cr.danubedata.ro/safi4/gym:latest') => ({
  success: true,
  data: { repository: 'safi4/gym', permitted: true, namespace: 'safi4', provided_namespace: 'safi4', push_reference: pushReference },
  error: null,
  meta: {},
});

const dockerVerdict = (over: Record<string, unknown> = {}) => ({
  registry_host: 'cr.danubedata.ro', repository: 'safi4/gym', status: 'push', can_push: true, actions: ['pull', 'push'],
  message: "Docker's login for cr.danubedata.ro can push to safi4/gym", ...over,
});

describe('danube registry verify-push', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGet.mockReset();
    mockCheck.mockReset();
    process.exitCode = undefined;
    setJsonMode(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    setJsonMode(false);
  });

  const printed = (): string => logSpy.mock.calls.flat().join('\n');

  it('checks Docker credentials for the repository path the server resolved, and reports a push grant', async () => {
    mockGet.mockResolvedValue(permitted());
    mockCheck.mockResolvedValue(dockerVerdict());

    await verify('gym');

    expect(mockCheck).toHaveBeenCalledWith('cr.danubedata.ro', 'safi4/gym');
    expect(printed()).toContain('Push permitted');
    expect(printed()).toContain("Docker's login for cr.danubedata.ro can push to safi4/gym");
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 1 when the server permits but Docker would be refused', async () => {
    mockGet.mockResolvedValue(permitted());
    mockCheck.mockResolvedValue(dockerVerdict({ status: 'no_credentials', can_push: false, actions: [], message: 'Docker has no login for cr.danubedata.ro: run danube registry login' }));

    await verify('gym');

    expect(printed()).toContain('Push permitted');
    expect(printed()).toContain('Docker has no login for cr.danubedata.ro: run danube registry login');
    expect(process.exitCode).toBe(1);
  });

  it('does not fail on a check that could not decide', async () => {
    mockGet.mockResolvedValue(permitted());
    mockCheck.mockResolvedValue(dockerVerdict({ status: 'unknown', can_push: null, actions: [], message: "Could not check Docker's credentials: offline" }));

    await verify('gym');

    expect(printed()).toContain("Could not check Docker's credentials: offline");
    expect(process.exitCode).toBeUndefined();
  });

  it('adds the verdict to the JSON data and keeps the server answer', async () => {
    setJsonMode(true);
    mockGet.mockResolvedValue(permitted());
    mockCheck.mockResolvedValue(dockerVerdict({ status: 'pull_only', can_push: false, actions: ['pull'] }));

    await verify('gym');

    const out = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(out.data).toMatchObject({ permitted: true, push_reference: 'cr.danubedata.ro/safi4/gym:latest', docker: { status: 'pull_only', can_push: false, actions: ['pull'] } });
    expect(process.exitCode).toBe(1);
  });

  it('leaves the JSON data as the server sent it for a refused push, and checks nothing', async () => {
    setJsonMode(true);
    mockGet.mockResolvedValue({
      success: false, data: { repository: 'x/gym', permitted: false, namespace: 'safi4', provided_namespace: 'x', push_reference: null },
      error: { code: 'namespace_mismatch', message: 'wrong' }, meta: {},
    });

    await verify('x/gym');

    const out = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(out.data).not.toHaveProperty('docker');
    expect(mockCheck).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('keeps the server refusal output, without a Docker line', async () => {
    mockGet.mockResolvedValue({
      success: false, data: { repository: 'x/gym', permitted: false, namespace: 'safi4', provided_namespace: 'x', push_reference: null },
      error: { code: 'namespace_mismatch', message: 'wrong namespace', hint: 'use safi4/gym' }, meta: {},
    });

    await verify('x/gym');

    expect(errSpy.mock.calls.flat().join('\n')).toContain('Push refused: namespace_mismatch');
    expect(errSpy.mock.calls.flat().join('\n')).toContain('use safi4/gym');
    expect(mockCheck).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('asks for the registry host when the reference has none', async () => {
    mockGet
      .mockResolvedValueOnce(permitted('safi4/gym:latest'))
      .mockResolvedValueOnce({ success: true, data: { registry_host: 'cr.danubedata.ro' } });
    mockCheck.mockResolvedValue(dockerVerdict());

    await verify('gym');

    expect(mockGet).toHaveBeenLastCalledWith('/api/v1/registry/context');
    expect(mockCheck).toHaveBeenCalledWith('cr.danubedata.ro', 'safi4/gym');
  });

  it('skips the Docker check, and says nothing about it, when the host cannot be found', async () => {
    mockGet.mockResolvedValueOnce(permitted('safi4/gym:latest')).mockRejectedValueOnce(new Error('offline'));

    await verify('gym');

    expect(mockCheck).not.toHaveBeenCalled();
    expect(printed()).toContain('Push permitted');
    expect(process.exitCode).toBeUndefined();
  });

  it('prints a push permitted without a reference and skips the check', async () => {
    const answer = permitted();
    answer.data.push_reference = null as unknown as string;
    mockGet.mockResolvedValue(answer);

    await verify('gym');

    expect(mockCheck).not.toHaveBeenCalled();
    expect(printed()).toContain('Push permitted');
  });
});
