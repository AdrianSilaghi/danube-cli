import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPut = vi.fn();
const mockPatch = vi.fn();
const mockDelete = vi.fn();
vi.mock('../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () =>
      Promise.resolve({ get: mockGet, post: mockPost, put: mockPut, patch: mockPatch, delete: mockDelete }),
  },
}));

vi.mock('@inquirer/prompts', () => ({
  confirm: () => Promise.resolve(true),
  input: () => Promise.resolve(''),
  select: () => Promise.resolve(''),
}));

const { metricAlertsCommand } = await import('../../src/commands/metric-alerts/index.js');
const { registryCommand } = await import('../../src/commands/registry/index.js');
const { setJsonMode } = await import('../../src/lib/json-mode.js');

const sub = (g: { commands: ReadonlyArray<{ name(): string }> }) => g.commands.map((c) => c.name());
const run = (g: { parseAsync: (a: string[], o: object) => Promise<unknown> }, args: string[]) =>
  g.parseAsync(args, { from: 'user' });

describe('metric alert commands', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    [mockGet, mockPost, mockPut, mockPatch, mockDelete].forEach((m) => m.mockReset());
    process.exitCode = undefined;
    setJsonMode(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    setJsonMode(false);
  });

  const output = () => logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');

  it('exposes the surface the API serves', () => {
    expect(sub(metricAlertsCommand)).toEqual(
      expect.arrayContaining(['ls', 'available-metrics', 'create', 'get', 'update', 'toggle', 'history', 'rm']),
    );
  });

  /**
   * The API reports capabilities.diagnose:false for alerts — history IS the
   * diagnosis. A diagnose command here would 404.
   */
  it('offers no diagnose command, because the API does not serve one', () => {
    expect(sub(metricAlertsCommand)).not.toContain('diagnose');
  });

  it('rejects an unknown comparison operator before making a request', async () => {
    await expect(
      run(metricAlertsCommand, [
        'create', '--resource-type', 'vps', '--resource-id', 'v-1',
        '--metric', 'cpu', '--operator', 'greater', '--threshold', '80',
      ]),
    ).rejects.toThrow(/Invalid --operator/);

    expect(mockPost).not.toHaveBeenCalled();
  });

  it('rejects an unknown notification channel', async () => {
    await expect(
      run(metricAlertsCommand, [
        'create', '--resource-type', 'vps', '--resource-id', 'v-1',
        '--metric', 'cpu', '--operator', 'gt', '--threshold', '80', '--channels', 'sms',
      ]),
    ).rejects.toThrow(/Invalid --channels/);
  });

  it('sends threshold as a number, not a string', async () => {
    mockPost.mockResolvedValueOnce({ data: { id: 'al-1' } });

    await run(metricAlertsCommand, [
      'create', '--resource-type', 'vps', '--resource-id', 'v-1',
      '--metric', 'cpu_usage', '--operator', 'gte', '--threshold', '80',
    ]);

    const [, body] = mockPost.mock.calls[0] ?? [];
    expect(body).toMatchObject({ resource_type: 'vps', comparison_operator: 'gte', threshold_value: 80 });
    // A string here silently fails numeric validation server-side.
    expect(typeof (body as Record<string, unknown>).threshold_value).toBe('number');
  });

  it('refuses an update with nothing to change', async () => {
    await run(metricAlertsCommand, ['update', 'my-alert']);

    expect(process.exitCode).toBe(2);
    expect(mockPut).not.toHaveBeenCalled();
  });

  /**
   * A catalogue that lists metrics is not proof the platform can evaluate
   * them. meta.alertable is the honest signal, and hiding it would let someone
   * create an alert that never fires.
   */
  it('warns when a resource type has no registered evaluator', async () => {
    mockGet.mockResolvedValueOnce({
      data: [{ type: 'cpu_usage', label: 'CPU', unit: '%' }],
      meta: { alertable: false },
    });

    await run(metricAlertsCommand, ['available-metrics', 'cache']);

    expect(output()).toMatch(/would never fire/);
  });

  it('reports the state the server returned after a toggle, not an assumed flip', async () => {
    mockGet.mockResolvedValueOnce({ data: [{ id: 'al-1', name: 'cpu-high' }] });
    mockPatch.mockResolvedValueOnce({ data: { enabled: false } });

    await run(metricAlertsCommand, ['toggle', 'cpu-high']);

    expect(output()).toContain('disabled');
  });
});

describe('registry repository commands', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    [mockGet, mockPost, mockPut, mockPatch, mockDelete].forEach((m) => m.mockReset());
    process.exitCode = undefined;
    setJsonMode(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    setJsonMode(false);
  });

  const output = () => logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');

  it('adds repos and usage alongside the existing context and verify-push', () => {
    expect(sub(registryCommand)).toEqual(
      expect.arrayContaining(['context', 'verify-push', 'repos', 'usage']),
    );
  });

  /**
   * Repositories exist because something was pushed. A create command would
   * either lie or invent a local row the registry does not know about.
   */
  it('offers no create, because pushing is what creates a repository', () => {
    const repos = registryCommand.commands.find((c) => c.name() === 'repos');
    expect(sub(repos as never)).not.toContain('create');
    expect(sub(repos as never)).toEqual(expect.arrayContaining(['ls', 'get', 'tags', 'rm-tag', 'rm']));
  });

  /**
   * The API refuses to drop a local record unless Distribution confirms,
   * answering 503. Reporting that as success would tell someone their image is
   * gone while the bytes, and the quota, remain.
   */
  it('surfaces a 503 delete refusal instead of claiming success', async () => {
    mockGet.mockResolvedValueOnce({ data: [{ id: 'r-1', path: 'proj/api', tag_count: 1 }] });
    const refusal = Object.assign(new Error('Service Unavailable'), { status: 503 });
    mockDelete.mockRejectedValueOnce(refusal);

    await expect(run(registryCommand, ['repos', 'rm-tag', 'proj/api', 'v1', '--force'])).rejects.toThrow();

    expect(errSpy.mock.calls.join(' ')).toMatch(/did not confirm the delete/);
    expect(output()).not.toMatch(/deleted/);
  });

  it('prints the digest alongside each tag', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    mockGet
      .mockResolvedValueOnce({ data: [{ id: 'r-1', path: 'proj/api' }] })
      .mockResolvedValueOnce({ data: [{ tag: 'v1', digest, bytes_size: 1024, pushed_at: '2026-01-02T03:04:05Z' }] });

    await run(registryCommand, ['repos', 'tags', 'proj/api']);

    // A tag can be moved by a later push, so anything pinning bytes needs this.
    expect(output()).toContain(digest);
  });

  /** 0 is the unlimited sentinel; printing it as "0" reads as "no room at all". */
  it('renders a zero limit as unlimited', async () => {
    mockGet.mockResolvedValueOnce({
      data: { bytes_used: 2048, repository_count: 3, max_bytes: 0, max_repositories: 0 },
      meta: { unlimited_is_zero: true },
    });

    await run(registryCommand, ['usage']);

    expect(output()).toMatch(/unlimited/);
    expect(output()).not.toMatch(/limit\s+0\b/i);
  });
});
