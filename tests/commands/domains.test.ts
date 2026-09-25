import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockDelete = vi.fn();
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
    };
    return instance;
  },
}));

vi.mock('../../src/lib/sleep.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

const { domainsCommand } = await import('../../src/commands/domains.js');
const { setJsonMode } = await import('../../src/lib/json-mode.js');
const { NotLinkedError } = await import('../../src/lib/errors.js');

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

const SITE_ID = '01a0d8fa-35fa-709d-b9d1-319c28ba28fa';
const DOMAIN_ID = '01a0d907-2bd8-72e3-9734-3e18bf4ed6bc';
const DOMAINS = `/api/v1/static-sites/${SITE_ID}/domains`;
const TOKEN = '6855b2e19187e54bae7a922263c206de786680222ac1f949c12c20b263a17499';

/** The shape the API actually returns — the old fixtures invented `type`, `status` and `verification_record`. */
const makeDomain = (overrides: Record<string, unknown> = {}) => ({
  id: DOMAIN_ID,
  domain: 'www.example.com',
  verification_status: 'pending',
  tls_status: 'pending',
  deployment_status: 'pending',
  is_primary: true,
  dns_instructions: {
    record_type: 'TXT',
    record_name: '_danubedata-verify.www.example.com',
    record_value: TOKEN,
    instructions: `Add a TXT record with the name '_danubedata-verify.www.example.com' and value '${TOKEN}' to your DNS provider.`,
  },
  created_at: '2026-09-25T14:45:20+00:00',
  ...overrides,
});

describe('domains command', () => {
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
    mockDelete.mockReset();
    mockOpenLinkedSite.mockReset();
    mockOpenLinkedSite.mockResolvedValue({
      project: { siteId: SITE_ID, teamId: 4, siteName: 'site' },
      api: { get: mockGet, post: mockPost, delete: mockDelete },
      site: { id: SITE_ID, url: 'https://site-ab12.pages.danubedata.ro' },
    });
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
        domainsCommand.parseAsync(['node', 'test', 'ls']),
      ).rejects.toThrow('No project linked');
    });

    it('shows the default domain when there are no custom ones', async () => {
      mockGet.mockResolvedValue({ data: [] });

      await domainsCommand.parseAsync(['node', 'test', 'ls']);

      expect(logged()).toContain('Default: site-ab12.pages.danubedata.ro');
      expect(logged()).toContain('No custom domains configured.');
    });

    /** The regression: this crashed with "Cannot read properties of undefined (reading 'replace')". */
    it('lists real domains without crashing', async () => {
      mockGet.mockResolvedValue({ data: [makeDomain(), makeDomain({ domain: 'example.com', verification_status: 'verified', tls_status: 'active', is_primary: false })] });

      await domainsCommand.parseAsync(['node', 'test', 'ls']);

      expect(mockGet).toHaveBeenCalledWith(DOMAINS);
      expect(logged()).toContain('VERIFICATION');
      expect(logged()).toContain('www.example.com');
      expect(logged()).toContain('verified');
    });

    it('lists as JSON', async () => {
      setJsonMode(true);
      mockGet.mockResolvedValue({ data: [makeDomain()] });

      await domainsCommand.parseAsync(['node', 'test', 'ls']);

      expect(envelope()).toMatchObject({ success: true, data: [{ id: DOMAIN_ID, verification_status: 'pending' }] });
    });
  });

  describe('add', () => {
    /** The regression: the DNS record was never printed, so nobody could verify. */
    it('prints the TXT record and the CNAME target', async () => {
      mockPost.mockResolvedValue({ message: 'Domain added.', data: makeDomain() });

      await domainsCommand.parseAsync(['node', 'test', 'add', 'www.example.com']);

      expect(mockPost).toHaveBeenCalledWith(DOMAINS, { domain: 'www.example.com' });
      expect(spinner).toEqual(['succeed:Added www.example.com']);
      const output = logged();
      expect(output).toContain(`TXT  _danubedata-verify.www.example.com  ${TOKEN}`);
      expect(output).toContain('danube pages domains verify www.example.com');
      expect(output).toContain('www.example.com  CNAME  site-ab12.pages.danubedata.ro');
      expect(output).toContain('ALIAS or ANAME');
    });

    it('still gives the CNAME target without DNS instructions', async () => {
      mockPost.mockResolvedValue({ message: 'Domain added.', data: makeDomain({ dns_instructions: null }) });

      await domainsCommand.parseAsync(['node', 'test', 'add', 'www.example.com']);

      expect(logged()).not.toContain('TXT');
      expect(logged()).toContain('1. Point the domain at your site:');
    });

    it('includes the CNAME target under --json', async () => {
      setJsonMode(true);
      mockPost.mockResolvedValue({ message: 'Domain added.', data: makeDomain() });

      await domainsCommand.parseAsync(['node', 'test', 'add', 'www.example.com']);

      expect(envelope().data).toMatchObject({ domain: 'www.example.com', cname_target: 'site-ab12.pages.danubedata.ro' });
    });
  });

  describe('remove', () => {
    it('exits when domain not found', async () => {
      mockGet.mockResolvedValue({ data: [] });

      await expect(
        domainsCommand.parseAsync(['node', 'test', 'remove', 'nope.com']),
      ).rejects.toThrow(ExitError);

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
    });

    it('removes the domain', async () => {
      mockGet.mockResolvedValue({ data: [makeDomain()] });
      mockDelete.mockResolvedValue({ message: 'Removed' });

      await domainsCommand.parseAsync(['node', 'test', 'remove', 'www.example.com']);

      expect(mockDelete).toHaveBeenCalledWith(`${DOMAINS}/${DOMAIN_ID}`);
      expect(spinner).toEqual(['succeed:Removed www.example.com']);
    });

    it('reports removal as JSON', async () => {
      setJsonMode(true);
      mockGet.mockResolvedValue({ data: [makeDomain()] });
      mockDelete.mockResolvedValue({ message: 'Removed' });

      await domainsCommand.parseAsync(['node', 'test', 'remove', 'www.example.com']);

      expect(envelope().data).toEqual({ status: 'removed', domain: 'www.example.com' });
    });
  });

  describe('verify', () => {
    it('exits when domain not found', async () => {
      mockGet.mockResolvedValue({ data: [] });

      await expect(
        domainsCommand.parseAsync(['node', 'test', 'verify', 'nope.com']),
      ).rejects.toThrow(ExitError);
    });

    it('waits for and reports a successful verification', async () => {
      mockGet
        .mockResolvedValueOnce({ data: [makeDomain()] })
        .mockResolvedValueOnce({ data: [makeDomain()] })
        .mockResolvedValue({ data: [makeDomain({ verification_status: 'verified' })] });
      mockPost.mockResolvedValue({ message: 'Verification started.' });

      await domainsCommand.parseAsync(['node', 'test', 'verify', 'www.example.com']);

      expect(mockPost).toHaveBeenCalledWith(`${DOMAINS}/${DOMAIN_ID}/verify`);
      expect(spinner).toEqual(['succeed:Verified www.example.com']);
      expect(logged()).toContain('www.example.com  CNAME  site-ab12.pages.danubedata.ro');
    });

    it('reports verification as JSON', async () => {
      setJsonMode(true);
      mockGet
        .mockResolvedValueOnce({ data: [makeDomain()] })
        .mockResolvedValue({ data: [makeDomain({ verification_status: 'verified' })] });
      mockPost.mockResolvedValue({ message: 'Verification started.' });

      await domainsCommand.parseAsync(['node', 'test', 'verify', 'www.example.com']);

      expect(envelope().data).toEqual({ status: 'verified', domain: 'www.example.com', cname_target: 'site-ab12.pages.danubedata.ro' });
    });

    it('exits 1 with the record to create when it does not verify', async () => {
      let now = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => (now += 10_000));
      mockGet.mockResolvedValue({ data: [makeDomain({ verification_status: 'failed' })] });
      mockPost.mockResolvedValue({ message: 'Verification started.' });

      await expect(domainsCommand.parseAsync(['node', 'test', 'verify', 'www.example.com'])).rejects.toThrow(ExitError);

      expect(process.exit).toHaveBeenCalledWith(1);
      expect(spinner).toEqual(['fail:www.example.com is not verified yet']);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('the TXT record was not found'));
      expect(logged()).toContain(`TXT  _danubedata-verify.www.example.com  ${TOKEN}`);
    });

    it('stops waiting as soon as a pending domain fails its check', async () => {
      mockGet
        .mockResolvedValueOnce({ data: [makeDomain()] })
        .mockResolvedValue({ data: [makeDomain({ verification_status: 'failed' })] });
      mockPost.mockResolvedValue({ message: 'Verification started.' });

      await expect(domainsCommand.parseAsync(['node', 'test', 'verify', 'www.example.com'])).rejects.toThrow(ExitError);

      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(spinner).toEqual(['fail:www.example.com is not verified yet']);
    });

    it('falls back to the original record when the domain disappears mid-wait', async () => {
      let now = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => (now += 40_000));
      mockGet.mockResolvedValueOnce({ data: [makeDomain()] }).mockResolvedValue({ data: [] });
      mockPost.mockResolvedValue({ message: 'Verification started.' });

      await expect(domainsCommand.parseAsync(['node', 'test', 'verify', 'www.example.com'])).rejects.toThrow(ExitError);

      expect(logged()).toContain(`TXT  _danubedata-verify.www.example.com  ${TOKEN}`);
    });

    it('emits a retryable failure envelope under --json', async () => {
      setJsonMode(true);
      let now = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => (now += 10_000));
      mockGet.mockResolvedValue({ data: [makeDomain({ verification_status: 'failed' })] });
      mockPost.mockResolvedValue({ message: 'Verification started.' });

      await expect(domainsCommand.parseAsync(['node', 'test', 'verify', 'www.example.com'])).rejects.toThrow(ExitError);

      expect(envelope()).toMatchObject({
        success: false,
        data: { status: 'not_verified', domain: 'www.example.com' },
        error: { code: 'static_site.domain_not_verified', retryable: true },
      });
    });

    it('starts verification without waiting with --no-wait', async () => {
      mockGet.mockResolvedValue({ data: [makeDomain()] });
      mockPost.mockResolvedValue({ message: 'Verification started.' });

      await domainsCommand.parseAsync(['node', 'test', 'verify', 'www.example.com', '--no-wait']);

      expect(spinner).toEqual(['succeed:Verification started for www.example.com']);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('keeps the old JSON shape with --no-wait', async () => {
      setJsonMode(true);
      mockGet.mockResolvedValue({ data: [makeDomain()] });
      mockPost.mockResolvedValue({ message: 'Verification started.' });

      await domainsCommand.parseAsync(['node', 'test', 'verify', 'www.example.com', '--no-wait']);

      expect(envelope().data).toEqual({ status: 'verification_started', domain: 'www.example.com' });
    });
  });
});
