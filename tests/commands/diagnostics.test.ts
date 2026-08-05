import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
vi.mock('../../src/lib/api-client.js', () => ({
  ApiClient: { create: () => Promise.resolve({ get: mockGet }) },
}));

const { createDiagnoseCommand, createLogsCommand, createEventsCommand } = await import(
  '../../src/lib/diagnostics/commands.js'
);
const { setJsonMode } = await import('../../src/lib/json-mode.js');

const TARGET = {
  noun: 'cache instance',
  kind: 'cache',
  listPath: '/api/v1/cache',
  resourcePath: (id: string) => `/api/v1/cache/${id}`,
};

/** resolveResource pages the collection first, so every call answers that. */
const listResponse = { data: [{ id: 'cache-1', name: 'my-cache' }] };

function envelope<T>(data: T, meta: Record<string, unknown> = {}) {
  return { success: true, data, error: null, meta };
}

describe('platform diagnostics commands', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGet.mockReset();
    process.exitCode = undefined;
    setJsonMode(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    setJsonMode(false);
  });

  const output = () => logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');

  describe('diagnose', () => {
    it('exits 1 when a finding is fatal', async () => {
      mockGet
        .mockResolvedValueOnce(listResponse)
        .mockResolvedValueOnce(
          envelope({
            verdict: 'failed',
            findings: [
              { code: 'cache.oom_killed', severity: 'fatal', summary: 'Killed for exceeding memory.', retryable: false },
            ],
          }),
        );

      await createDiagnoseCommand(TARGET).parseAsync(['my-cache'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(output()).toContain('cache.oom_killed');
    });

    /**
     * A healthy resource must not exit non-zero, or every CI pipeline that
     * runs diagnose as a gate fails permanently.
     */
    it('leaves the exit code alone when nothing is fatal', async () => {
      mockGet
        .mockResolvedValueOnce(listResponse)
        .mockResolvedValueOnce(
          envelope({
            verdict: 'ready',
            findings: [{ code: 'cache.healthy', severity: 'informational', summary: 'No problems found.' }],
          }),
        );

      await createDiagnoseCommand(TARGET).parseAsync(['my-cache'], { from: 'user' });

      expect(process.exitCode).toBeUndefined();
    });

    /**
     * `success` reports the CALL, not the verdict. A diagnose that finds a
     * fatal problem succeeded at diagnosing; the verdict is in data and in the
     * exit code. Flipping this would make agents treat a working diagnosis as
     * a transport failure.
     */
    it('reports success:true in JSON even when the verdict is fatal', async () => {
      setJsonMode(true);
      mockGet
        .mockResolvedValueOnce(listResponse)
        .mockResolvedValueOnce(
          envelope({
            verdict: 'failed',
            findings: [{ code: 'cache.crash_loop', severity: 'fatal', summary: 'Restarting repeatedly.' }],
          }),
        );

      await createDiagnoseCommand(TARGET).parseAsync(['my-cache'], { from: 'user' });

      const emitted = JSON.parse(output());
      expect(emitted.success).toBe(true);
      expect(emitted.data.findings[0].code).toBe('cache.crash_loop');
      expect(emitted.meta.finding_count).toBe(1);
      expect(process.exitCode).toBe(1);
    });

    it('orders findings worst-first regardless of server order', async () => {
      mockGet.mockResolvedValueOnce(listResponse).mockResolvedValueOnce(
        envelope({
          findings: [
            { code: 'cache.note', severity: 'informational', summary: 'Context.' },
            { code: 'cache.bad', severity: 'fatal', summary: 'Broken.' },
          ],
        }),
      );

      await createDiagnoseCommand(TARGET).parseAsync(['my-cache'], { from: 'user' });

      const text = output();
      expect(text.indexOf('cache.bad')).toBeLessThan(text.indexOf('cache.note'));
    });

    it('says so when a section could not be read', async () => {
      mockGet.mockResolvedValueOnce(listResponse).mockResolvedValueOnce(
        envelope({
          findings: [],
          sections: { events: { available: false }, logs: { available: true, sampled_lines: 10 } },
        }),
      );

      await createDiagnoseCommand(TARGET).parseAsync(['my-cache'], { from: 'user' });

      expect(output()).toContain('events: unavailable');
    });
  });

  describe('logs', () => {
    /**
     * The distinction the whole envelope exists for: an unreachable backend
     * says nothing about the workload, while an empty window says the workload
     * printed nothing. Conflating them sends people debugging the wrong thing.
     */
    it('distinguishes an unavailable backend from an empty window', async () => {
      mockGet.mockResolvedValueOnce(listResponse).mockResolvedValueOnce(envelope({ available: false }));

      await createLogsCommand(TARGET).parseAsync(['my-cache'], { from: 'user' });

      expect(errSpy.mock.calls.join(' ')).toContain('says nothing about the cache instance');

      mockGet.mockReset();
      mockGet.mockResolvedValueOnce(listResponse).mockResolvedValueOnce(envelope({ available: true, entries: [] }));

      await createLogsCommand(TARGET).parseAsync(['my-cache'], { from: 'user' });

      expect(output()).toContain('No log entries in this window');
    });

    it('rejects an unknown --level before making a request', async () => {
      await expect(
        createLogsCommand(TARGET).parseAsync(['my-cache', '--level', 'critical'], { from: 'user' }),
      ).rejects.toThrow(/Invalid --level/);

      expect(mockGet).not.toHaveBeenCalled();
    });

    it('resolves --since to an absolute timestamp in the query', async () => {
      mockGet.mockResolvedValueOnce(listResponse).mockResolvedValueOnce(envelope({ available: true, entries: [] }));

      await createLogsCommand(TARGET).parseAsync(['my-cache', '--since', '2h'], { from: 'user' });

      const url = String(mockGet.mock.calls[1]?.[0]);
      const since = new URL(url, 'https://x').searchParams.get('since');
      expect(since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    /** Log text is whatever the workload printed — it must not drive the terminal. */
    it('strips terminal escapes from log lines', async () => {
      const ESC = '\u001b';
      mockGet.mockResolvedValueOnce(listResponse).mockResolvedValueOnce(
        envelope({
          available: true,
          entries: [{ timestamp: '2026-01-02T03:04:05Z', level: 'info', message: `${ESC}[2Jwiped` }],
        }),
      );

      await createLogsCommand(TARGET).parseAsync(['my-cache'], { from: 'user' });

      expect(output()).toContain('wiped');
      expect(output()).not.toContain(ESC);
    });
  });

  describe('events', () => {
    it('distinguishes unavailable from empty', async () => {
      mockGet.mockResolvedValueOnce(listResponse).mockResolvedValueOnce(envelope({ available: false }));

      await createEventsCommand(TARGET).parseAsync(['my-cache'], { from: 'user' });

      expect(errSpy.mock.calls.join(' ')).toContain('says nothing about the cache instance');
    });

    it('renders reason and message for each event', async () => {
      mockGet.mockResolvedValueOnce(listResponse).mockResolvedValueOnce(
        envelope({
          available: true,
          events: [{ type: 'Warning', reason: 'OOMKilling', message: 'exceeded memory', last_seen: '2026-01-02T03:04:05Z' }],
        }),
      );

      await createEventsCommand(TARGET).parseAsync(['my-cache'], { from: 'user' });

      expect(output()).toContain('OOMKilling');
      expect(output()).toContain('exceeded memory');
    });
  });
});

describe('product command trees', () => {
  /**
   * capabilities is derived server-side, and the CLI must agree with it: VPS
   * reports logs:false because guest output is the customer's, and buckets
   * have no log or event surface at all. Registering commands the API will
   * 404 is exactly the probing the capability field exists to remove.
   */
  it('registers only the surfaces each product actually serves', async () => {
    const { cacheCommand } = await import('../../src/commands/cache/index.js');
    const { databaseCommand } = await import('../../src/commands/database/index.js');
    const { vpsCommand } = await import('../../src/commands/vps/index.js');
    const { storageCommand } = await import('../../src/commands/storage/index.js');

    const names = (c: { commands: ReadonlyArray<{ name(): string }> }) => c.commands.map((s) => s.name());

    expect(names(cacheCommand)).toEqual(expect.arrayContaining(['diagnose', 'logs', 'events']));
    expect(names(databaseCommand)).toEqual(expect.arrayContaining(['diagnose', 'logs', 'events']));

    expect(names(vpsCommand)).toEqual(expect.arrayContaining(['diagnose', 'events']));
    expect(names(vpsCommand)).not.toContain('logs');

    expect(names(storageCommand)).toContain('diagnose');
    expect(names(storageCommand)).not.toContain('logs');
    expect(names(storageCommand)).not.toContain('events');
  });
});
