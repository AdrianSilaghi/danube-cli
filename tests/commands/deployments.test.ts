import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockOpenLinkedSite = vi.fn();
vi.mock('../../src/lib/linked-site.js', () => ({
  openLinkedSite: () => mockOpenLinkedSite(),
}));

const spinner: string[] = [];
vi.mock('ora', () => ({
  default: () => {
    const instance = {
      start: () => instance,
      succeed: (t: string) => { spinner.push(`succeed:${t}`.replace(/\x1b\[[0-9;]*m/g, '')); return instance; },
      fail: (t: string) => { spinner.push(`fail:${t}`.replace(/\x1b\[[0-9;]*m/g, '')); return instance; },
      warn: (t: string) => { spinner.push(`warn:${t}`.replace(/\x1b\[[0-9;]*m/g, '')); return instance; },
    };
    return instance;
  },
}));

vi.mock('../../src/lib/sleep.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

const { deploymentsCommand } = await import('../../src/commands/deployments.js');
const { setJsonMode } = await import('../../src/lib/json-mode.js');
const { NotLinkedError } = await import('../../src/lib/errors.js');

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

const SITE_ID = '01a0d8fa-35fa-709d-b9d1-319c28ba28fa';
const URL = 'https://site-ab12.pages.danubedata.ro';
const DEPLOYMENTS = `/api/v1/static-sites/${SITE_ID}/deployments`;

const site = (overrides: Record<string, unknown> = {}) => ({
  id: SITE_ID, status: 'active', last_error: null, url: URL, deployment_count: 2, ...overrides,
});
const deployment = (id: string, revision: number, overrides: Record<string, unknown> = {}) => ({
  id, revision_number: revision, status: 'active', is_current: false, trigger_type: 'manual',
  deployed_at: '2026-09-25T14:32:01+00:00', created_at: '2026-09-25T14:32:01+00:00', ...overrides,
});

/** Deployment pages and site polls, each served in order with the last repeating. */
function serve(pages: unknown[], sites: unknown[] = [site()]): void {
  const next = (queue: unknown[]) => (queue.length > 1 ? queue.shift() : queue[0]);
  mockGet.mockImplementation(async (path: string) =>
    path.startsWith(DEPLOYMENTS) ? next(pages) : { data: next(sites) });
}

describe('deployments command', () => {
  const originalExit = process.exit;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  const logged = () => consoleLogSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  const envelope = () => JSON.parse(String(consoleLogSpy.mock.calls.at(-1)![0]));

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exit = vi.fn().mockImplementation((code: number) => {
      throw new ExitError(code);
    }) as never;
    spinner.length = 0;
    mockGet.mockReset();
    mockPost.mockReset();
    mockOpenLinkedSite.mockReset();
    mockOpenLinkedSite.mockResolvedValue({
      project: { siteId: SITE_ID, teamId: 4, siteName: 'site' },
      api: { get: mockGet, post: mockPost },
      site: site(),
    });
    mockPost.mockResolvedValue({ message: 'Rollback to revision #1 initiated.' });
  });

  afterEach(() => {
    process.exit = originalExit;
    setJsonMode(false);
    vi.restoreAllMocks();
  });

  describe('ls', () => {
    it('throws NotLinkedError when no project', async () => {
      mockOpenLinkedSite.mockRejectedValue(new NotLinkedError());
      await expect(
        deploymentsCommand.parseAsync(['node', 'test', 'ls']),
      ).rejects.toThrow('No project linked');
    });

    it('shows message when no deployments', async () => {
      serve([{ data: [] }]);

      await deploymentsCommand.parseAsync(['node', 'test', 'ls']);

      expect(consoleLogSpy).toHaveBeenCalledWith('No deployments yet.');
    });

    it('displays deployments table', async () => {
      serve([{
        data: [
          deployment('d3', 3, { is_current: true }),
          deployment('d2', 2, { status: 'inactive', deployed_at: null }),
        ],
      }]);

      await deploymentsCommand.parseAsync(['node', 'test', 'ls']);

      expect(logged()).toContain('REVISION');
      expect(logged()).toContain('(current)');
    });

    it('lists as JSON', async () => {
      setJsonMode(true);
      serve([{ data: [deployment('d3', 3)] }]);

      await deploymentsCommand.parseAsync(['node', 'test', 'ls']);

      expect(envelope()).toMatchObject({ success: true, data: [{ id: 'd3', revision_number: 3 }], meta: { count: 1 } });
    });

    it('fetches every page and shows a truncation note when capped', async () => {
      serve([{
        data: [deployment('d3', 3, { is_current: true })],
        pagination: { current_page: 1, last_page: 1, per_page: 100, total: 250 },
      }]);

      await deploymentsCommand.parseAsync(['node', 'test', 'ls']);

      expect(mockGet).toHaveBeenCalledWith(`${DEPLOYMENTS}?per_page=100&page=1`);
      expect(logged()).toContain('Showing 1 of 250');
    });
  });

  describe('rollback', () => {
    it('throws NotLinkedError when no project', async () => {
      mockOpenLinkedSite.mockRejectedValue(new NotLinkedError());
      await expect(
        deploymentsCommand.parseAsync(['node', 'test', 'rollback', '2']),
      ).rejects.toThrow('No project linked');
    });

    it('exits when revision not found', async () => {
      serve([{ data: [deployment('d3', 3)] }]);

      await expect(
        deploymentsCommand.parseAsync(['node', 'test', 'rollback', '99']),
      ).rejects.toThrow(ExitError);

      expect(process.exit).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
    });

    /**
     * The activate call only queues the rollback; "Rolled back" used to be
     * printed before anything had happened.
     */
    it('waits for the rollback to be published before saying so', async () => {
      serve(
        [{ data: [deployment('d2', 2), deployment('d1', 1)] }],
        [site(), site({ status: 'deploying' }), site({ deployment_count: 3 })],
      );

      await deploymentsCommand.parseAsync(['node', 'test', 'rollback', '1']);

      expect(mockPost).toHaveBeenCalledWith(`${DEPLOYMENTS}/d1/activate`);
      expect(spinner).toEqual(['succeed:Rolled back to revision 1 (published as revision #3)']);
    });

    /**
     * The baseline is read right before the activate call, not when the
     * command started: a revision recorded while every deployment page was
     * being listed would otherwise count as this rollback's.
     */
    it('takes its baseline after listing, right before activating', async () => {
      const order: string[] = [];
      serve([{ data: [deployment('d1', 1)] }], [site({ deployment_count: 3 }), site({ deployment_count: 4 })]);
      mockGet.mockImplementationOnce(async () => { order.push('list'); return { data: [deployment('d1', 1)] }; });
      mockPost.mockImplementation(async () => { order.push('activate'); return {}; });

      await deploymentsCommand.parseAsync(['node', 'test', 'rollback', '1']);

      expect(order).toEqual(['list', 'activate']);
      expect(spinner).toEqual(['succeed:Rolled back to revision 1 (published as revision #4)']);
    });

    it('reports the published revision under --json', async () => {
      setJsonMode(true);
      serve([{ data: [deployment('d1', 1)] }], [site(), site({ deployment_count: 3 })]);

      await deploymentsCommand.parseAsync(['node', 'test', 'rollback', '1']);

      expect(envelope()).toMatchObject({
        success: true,
        data: { status: 'activated', revision: 1, deployment_id: 'd1', published_revision: 3, url: URL },
      });
    });

    it('returns once accepted with --no-wait', async () => {
      serve([{ data: [deployment('d1', 1)] }]);

      await deploymentsCommand.parseAsync(['node', 'test', 'rollback', '1', '--no-wait']);

      expect(spinner).toEqual(['succeed:Rollback to revision 1 started']);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('keeps the old JSON shape with --no-wait', async () => {
      setJsonMode(true);
      serve([{ data: [deployment('d1', 1)] }]);

      await deploymentsCommand.parseAsync(['node', 'test', 'rollback', '1', '--no-wait']);

      expect(envelope()).toEqual({
        success: true, data: { status: 'activated', revision: 1, deployment_id: 'd1' }, error: null, meta: {},
      });
    });

    it('fails when the platform cannot publish the rollback', async () => {
      serve([{ data: [deployment('d1', 1)] }], [site(), site({ status: 'error', last_error: 'GitOps push failed' })]);

      await expect(deploymentsCommand.parseAsync(['node', 'test', 'rollback', '1'])).rejects.toThrow(ExitError);

      expect(process.exit).toHaveBeenCalledWith(1);
      expect(spinner).toEqual(['fail:Rollback to revision 1 did not complete']);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('GitOps push failed'));
    });

    /** The envelope used to keep `status: 'activated'` on a failed rollback. */
    it('emits a failure envelope under --json, with status failed', async () => {
      setJsonMode(true);
      serve([{ data: [deployment('d1', 1)] }], [site({ status: 'suspended' })]);

      await expect(deploymentsCommand.parseAsync(['node', 'test', 'rollback', '1'])).rejects.toThrow(ExitError);

      expect(envelope()).toEqual({
        success: false,
        data: { status: 'failed', revision: 1, deployment_id: 'd1' },
        error: { code: 'static_site.suspended', message: expect.stringContaining('suspended') },
        meta: {},
      });
    });

    it('reports a timeout under --json with status timeout, exiting 1', async () => {
      setJsonMode(true);
      let now = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => (now += 60_000));
      serve([{ data: [deployment('d1', 1)] }], [site({ status: 'deploying' })]);

      await expect(deploymentsCommand.parseAsync(['node', 'test', 'rollback', '1'])).rejects.toThrow(ExitError);

      expect(envelope()).toEqual({
        success: false,
        data: { status: 'timeout', revision: 1, deployment_id: 'd1' },
        error: { code: 'static_site.timeout', message: expect.stringContaining('Timed out waiting for the rollback'), retryable: true },
        meta: {},
      });
    });

    /** Same contract as `pages deploy`: the rollback is still in flight, so a person gets a warning and exit 0. */
    it('warns and exits 0 when the rollback outlasts the wait', async () => {
      let now = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => (now += 60_000));
      serve([{ data: [deployment('d1', 1)] }], [site({ status: 'deploying' })]);

      await deploymentsCommand.parseAsync(['node', 'test', 'rollback', '1']);

      expect(process.exit).not.toHaveBeenCalled();
      expect(spinner).toEqual([
        'warn:Timed out waiting for the rollback to be published. Check status with `danube pages deployments ls`.',
      ]);
    });

    it('walks multiple pages to find a revision beyond the first page', async () => {
      serve([
        { data: [deployment('d3', 3)], pagination: { current_page: 1, last_page: 2, per_page: 100, total: 2 } },
        { data: [deployment('d2', 2)], pagination: { current_page: 2, last_page: 2, per_page: 100, total: 2 } },
      ]);

      await deploymentsCommand.parseAsync(['node', 'test', 'rollback', '2', '--no-wait']);

      expect(mockGet).toHaveBeenNthCalledWith(1, `${DEPLOYMENTS}?per_page=100&page=1`);
      expect(mockGet).toHaveBeenNthCalledWith(2, `${DEPLOYMENTS}?per_page=100&page=2`);
      expect(mockPost).toHaveBeenCalledWith(`${DEPLOYMENTS}/d2/activate`);
    });
  });
});
