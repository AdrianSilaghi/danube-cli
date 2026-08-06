import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: { create: () => Promise.resolve({ get: mockGet }) },
}));

const { diagnoseCommand } = await import('../../../src/commands/serverless/diagnose.js');
const { setJsonMode } = await import('../../../src/lib/json-mode.js');

/**
 * The 1.0 envelope contract for `rapids diagnose`.
 *
 * Before 1.0 this set `error` from the worst finding, which made
 * `success: false` — a diagnosis that ran correctly and correctly identified a
 * broken container reported itself as a failed command. Callers could not tell
 * "we could not diagnose" from "we diagnosed, and the news is bad", and
 * `preflight` already disagreed with it.
 *
 * These pin the flip so it cannot quietly revert.
 */
describe('rapids diagnose --json envelope', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  /** resolveContainer lists first; then show / diagnose / revisions / events / logs. */
  function stubApi(statusSummary: string, errorCode: string | null): void {
    mockGet.mockImplementation((path: string) => {
      // Findings come from the platform now, not from correlating the other
      // sections here. This stub stands in for what the server returns.
      if (path.endsWith('/diagnose')) {
        return Promise.resolve({
          success: true,
          data: {
            verdict: errorCode ? 'fatal' : 'healthy',
            findings: errorCode
              ? [{
                  code: errorCode,
                  severity: 'fatal',
                  summary: 'The registry rejected the credential.',
                  remediation: 'Not retryable: retrying will fail identically. Fix the cause first.',
                  retryable: false,
                }]
              : [{
                  code: 'serverless.healthy',
                  severity: 'informational',
                  summary: 'No problems found.',
                  remediation: null,
                  retryable: false,
                }],
          },
          error: null,
          meta: {},
        });
      }
      if (path.endsWith('/revisions') || path.endsWith('/events') || path.includes('/logs')) {
        return Promise.resolve({ success: true, data: {}, error: null, meta: {} });
      }
      if (/\/serverless\/[^/]+$/.test(path)) {
        return Promise.resolve({
          container: {
            id: 'c-1',
            name: 'my-api',
            status_details: {
              summary: statusSummary,
              health: statusSummary === 'ready' ? 'healthy' : 'unhealthy',
              observed_at: '2026-08-06T10:00:00+00:00',
              stale: false,
              operation: { state: statusSummary === 'ready' ? 'succeeded' : 'failed', terminal: true },
              error: errorCode
                ? { code: errorCode, message: 'The registry rejected the credential.', retryable: false }
                : null,
            },
          },
        });
      }
      return Promise.resolve({ data: [{ id: 'c-1', name: 'my-api' }] });
    });
  }

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGet.mockReset();
    process.exitCode = undefined;
    setJsonMode(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    setJsonMode(false);
  });

  const emitted = () => JSON.parse(logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n'));

  it('reports success:true and exit code 1 when the verdict is fatal', async () => {
    stubApi('failed', 'serverless.image_pull_auth');

    await diagnoseCommand.parseAsync(['my-api'], { from: 'user' });

    const out = emitted();
    // The call succeeded. The container did not.
    expect(out.success).toBe(true);
    expect(out.error).toBeNull();
    expect(process.exitCode).toBe(1);
  });

  it('carries the verdict in meta so a caller need not walk the findings', async () => {
    stubApi('failed', 'serverless.image_pull_auth');

    await diagnoseCommand.parseAsync(['my-api'], { from: 'user' });

    const out = emitted();
    expect(out.meta.verdict).toBe('fatal');
    expect(out.meta.finding_count).toBeGreaterThan(0);
  });

  it('reports a healthy container as success:true with no exit code', async () => {
    stubApi('ready', null);

    await diagnoseCommand.parseAsync(['my-api'], { from: 'user' });

    const out = emitted();
    expect(out.success).toBe(true);
    expect(out.meta.verdict).toBe('healthy');
    expect(process.exitCode).toBeUndefined();
  });

  it('still returns the findings themselves in data', async () => {
    stubApi('failed', 'serverless.image_pull_auth');

    await diagnoseCommand.parseAsync(['my-api'], { from: 'user' });

    const out = emitted();
    expect(Array.isArray(out.data.findings)).toBe(true);
    expect(out.data.findings.some((f: { severity: string }) => f.severity === 'fatal')).toBe(true);
  });

  /**
   * The correlation moved to the platform, so a failed `/diagnose` call now
   * means NO findings at all. Reporting that as an empty list would read as
   * "nothing wrong" — the precise conflation this whole surface exists to
   * remove. It has to say it did not ask.
   */
  it('says the diagnosis was not fetched rather than returning a silently empty list', async () => {
    stubApi('ready', null);
    mockGet.mockImplementation((path: string) => {
      if (path.endsWith('/diagnose')) return Promise.reject(new Error('Service Unavailable'));
      if (path.endsWith('/revisions') || path.endsWith('/events') || path.includes('/logs')) {
        return Promise.resolve({ success: true, data: {}, error: null, meta: {} });
      }
      if (/\/serverless\/[^/]+$/.test(path)) {
        return Promise.resolve({ container: { id: 'c-1', name: 'my-api', status_details: null } });
      }
      return Promise.resolve({ data: [{ id: 'c-1', name: 'my-api' }] });
    });

    await diagnoseCommand.parseAsync(['my-api'], { from: 'user' });

    const out = emitted();
    // The command itself worked — it fetched what it could.
    expect(out.success).toBe(true);
    expect(out.data.findings.map((f: { code: string }) => f.code))
      .toContain('serverless.diagnose_unavailable');
    // Not "healthy". We did not look.
    expect(out.meta.verdict).toBe('unknown');
    expect(process.exitCode).toBeUndefined();
  });
});
