import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
vi.mock('../../src/lib/api-client.js', () => ({
  ApiClient: { create: () => Promise.resolve({ get: mockGet }) },
}));
// Polling is the behaviour under test; actually sleeping between polls would
// make the suite take minutes to assert something that is purely logical.
vi.mock('../../src/lib/sleep.js', () => ({ sleep: vi.fn(() => Promise.resolve()) }));

const { operationsCommand } = await import('../../src/commands/operations.js');
const { setJsonMode } = await import('../../src/lib/json-mode.js');

const operation = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    operation_id: 'op-1', resource_id: 'c-1', resource_type: 'serverless_container',
    kind: 'deploy', state: 'running', terminal: false, poll_after_ms: 3000,
    revision: 'my-api-00003', knative_revision: 'my-api-00003',
    image: 'cr.danubedata.ro/safi4/my-api:v1', started_at: '2026-08-04T10:00:00+00:00',
    finished_at: null, error: null,
    ...over,
  },
  error: null,
  meta: {},
});

const run = (args: string[]) => operationsCommand.parseAsync(['node', 'test', ...args]);

describe('operations wait', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const printed = () => JSON.parse(logSpy.mock.calls.at(-1)![0] as string);

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGet.mockReset();
    process.exitCode = undefined;
  });

  afterEach(() => {
    setJsonMode(false);
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('polls until the operation reports terminal, then stops', async () => {
    mockGet
      .mockResolvedValueOnce(operation({ state: 'queued' }))
      .mockResolvedValueOnce(operation({ state: 'running' }))
      .mockResolvedValueOnce(operation({ state: 'succeeded', terminal: true, poll_after_ms: null }));

    setJsonMode(true);
    await run(['wait', 'op-1']);

    expect(mockGet).toHaveBeenCalledTimes(3);
    expect(printed().data.state).toBe('succeeded');
    expect(printed().success).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('stops on `terminal` alone, even for a state it does not recognise', async () => {
    // Inferring the stop condition from `state` means every new state name
    // silently becomes "keep waiting" in one client and "finished" in another.
    mockGet.mockResolvedValue(operation({ state: 'superseded', terminal: true }));

    setJsonMode(true);
    await run(['wait', 'op-1']);

    expect(mockGet).toHaveBeenCalledTimes(1);
    // Terminal but not succeeded still exits non-zero: the deploy did not work.
    expect(process.exitCode).toBe(1);
  });

  it('keeps waiting on a state it does not recognise while terminal is false', async () => {
    mockGet
      .mockResolvedValueOnce(operation({ state: 'something-new', terminal: false }))
      .mockResolvedValueOnce(operation({ state: 'succeeded', terminal: true }));

    setJsonMode(true);
    await run(['wait', 'op-1']);

    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('exits non-zero and names the failure when the operation fails', async () => {
    mockGet.mockResolvedValue(operation({
      state: 'failed',
      terminal: true,
      error: { code: 'serverless.image_pull_auth', message: 'The registry rejected the credential.', retryable: false, reason: 'ContainerMissing' },
    }));

    setJsonMode(true);
    await run(['wait', 'op-1']);

    expect(printed().data.error.code).toBe('serverless.image_pull_auth');
    expect(printed().data.error.retryable).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('reports a timeout as unfinished, not as a failure', async () => {
    // The deploy may well still be succeeding. Calling it a failure is how a
    // caller comes to roll back something that was fine.
    mockGet.mockResolvedValue(operation({ state: 'running', terminal: false }));

    setJsonMode(true);
    await run(['wait', 'op-1', '--timeout', '1ms']);

    const payload = printed();
    expect(payload.success).toBe(false);
    expect(payload.error.code).toBe('operation.wait_timeout');
    expect(payload.error.retryable).toBe(true);
    expect(payload.error.message).toContain('has not failed');
    expect(process.exitCode).toBe(1);
  });

  it('reports how long it waited and how often it asked', async () => {
    mockGet.mockResolvedValue(operation({ state: 'succeeded', terminal: true }));

    setJsonMode(true);
    await run(['wait', 'op-1']);

    expect(printed().meta.polls).toBe(1);
    expect(printed().meta.timeout_ms).toBe(1_800_000);
  });

  it('rejects an unparseable timeout rather than silently defaulting', async () => {
    await expect(run(['wait', 'op-1', '--timeout', 'soon'])).rejects.toThrow(/Invalid duration/);
  });
});

describe('operations inspect', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGet.mockReset();
  });

  afterEach(() => {
    setJsonMode(false);
    vi.restoreAllMocks();
  });

  it('returns the operation in the standard envelope without polling', async () => {
    mockGet.mockResolvedValue(operation({ state: 'running' }));

    setJsonMode(true);
    await run(['inspect', 'op-1']);

    expect(mockGet).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logSpy.mock.calls.at(-1)![0] as string);
    expect(payload.success).toBe(true);
    expect(payload.data.terminal).toBe(false);
    expect(payload.data.poll_after_ms).toBe(3000);
  });

  it('accepts a resource id, since the operation row may not exist yet', async () => {
    mockGet.mockResolvedValue(operation({ operation_id: 'c-1', state: 'queued' }));

    setJsonMode(true);
    await run(['inspect', 'c-1']);

    expect(mockGet).toHaveBeenCalledWith('/api/v1/operations/c-1');
  });
});
