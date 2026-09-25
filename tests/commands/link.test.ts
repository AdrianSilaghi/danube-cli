import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockCreate = vi.fn();
vi.mock('../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: (...args: unknown[]) => {
      mockCreate(...args);
      return Promise.resolve({ get: mockGet, post: mockPost });
    },
  },
}));

const mockWriteProjectConfig = vi.fn();
vi.mock('../../src/lib/project.js', () => ({
  writeProjectConfig: (...args: unknown[]) => mockWriteProjectConfig(...args),
}));

const mockSelect = vi.fn();
const mockInput = vi.fn();
vi.mock('@inquirer/prompts', () => ({
  select: (...args: unknown[]) => mockSelect(...args),
  input: (...args: unknown[]) => mockInput(...args),
}));

const { linkCommand } = await import('../../src/commands/link.js');
const { setProjectOverride } = await import('../../src/lib/project-context.js');
const { UsageError } = await import('../../src/lib/errors.js');

const SITE_ID = '01a0d8fa-35fa-709d-b9d1-319c28ba28fa';
const NEW_SITE_ID = '01a0d8fa-0000-7000-8000-00000000002a';

const makeSite = (overrides = {}) => ({
  id: SITE_ID, name: 'my-site', slug: 'my-site-ab12',
  url: 'https://my-site-ab12.pages.danubedata.ro', status: 'active', deployment_count: 1,
  created_at: '2026-09-25T14:31:11+00:00', updated_at: '2026-09-25T14:31:11+00:00',
  ...overrides,
});

describe('link command', () => {
  const originalIsTTY = process.stdin.isTTY;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  const logged = () => consoleLogSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n').replace(/\x1b\[[0-9;]*m/g, '');

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mockGet.mockReset();
    mockPost.mockReset();
    mockCreate.mockReset();
    mockSelect.mockReset();
    mockInput.mockReset();
    mockWriteProjectConfig.mockReset();
    mockWriteProjectConfig.mockResolvedValue(undefined);
    setProjectOverride(null);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    setProjectOverride(null);
    vi.restoreAllMocks();
  });

  it('refuses to run under --json instead of hanging on a prompt', async () => {
    const { setJsonMode } = await import('../../src/lib/json-mode.js');
    setJsonMode(true);

    await expect(linkCommand.parseAsync(['node', 'test'])).rejects.toThrow(/interactive/);

    expect(mockGet).not.toHaveBeenCalled();
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockInput).not.toHaveBeenCalled();
    setJsonMode(false);
  });

  it('auto-selects single team and links existing site', async () => {
    const site = makeSite();
    mockGet
      .mockResolvedValueOnce({ data: [{ id: 1, name: 'My Team' }] })
      .mockResolvedValueOnce({ data: [site] });
    mockSelect.mockResolvedValueOnce(SITE_ID); // select existing site

    await linkCommand.parseAsync(['node', 'test']);

    expect(logged()).toContain('My Team');
    expect(mockWriteProjectConfig).toHaveBeenCalledWith({
      siteId: SITE_ID,
      teamId: 1,
      siteName: 'my-site',
      siteUrl: 'https://my-site-ab12.pages.danubedata.ro',
    });
  });

  /**
   * The regression: a site created in the chosen team took its plan from
   * whichever project happened to be selected, because the requests were not
   * scoped to the team the prompt had just asked for.
   */
  it('prompts for a team and scopes every later request to it', async () => {
    mockGet
      .mockResolvedValueOnce({ data: { 0: { id: 1, name: 'Team A' }, 1: { id: 2, name: 'Team B' } } })
      .mockResolvedValueOnce({ data: [makeSite()] });
    mockSelect
      .mockResolvedValueOnce(2)  // select Team B
      .mockResolvedValueOnce(SITE_ID); // select existing site

    await linkCommand.parseAsync(['node', 'test']);

    expect(mockSelect).toHaveBeenCalledTimes(2);
    expect(mockCreate).toHaveBeenNthCalledWith(2, { teamId: 2 });
    expect(mockGet).toHaveBeenCalledWith('/api/v1/teams/2/static-sites');
  });

  it('takes the team from --project instead of prompting', async () => {
    setProjectOverride(2);
    mockGet
      .mockResolvedValueOnce({ data: [{ id: 1, name: 'Team A' }, { id: 2, name: 'Team B' }] })
      .mockResolvedValueOnce({ data: [makeSite()] });
    mockSelect.mockResolvedValueOnce(SITE_ID);

    await linkCommand.parseAsync(['node', 'test']);

    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(logged()).toContain('Team B');
    expect(mockWriteProjectConfig).toHaveBeenCalledWith(expect.objectContaining({ teamId: 2 }));
  });

  it('refuses a --project the account does not belong to', async () => {
    setProjectOverride(99);
    mockGet.mockResolvedValueOnce({ data: [{ id: 1, name: 'Team A' }] });

    await expect(linkCommand.parseAsync(['node', 'test'])).rejects.toThrow(UsageError);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('creates new site when selected, in the chosen team', async () => {
    const newSite = makeSite({ id: NEW_SITE_ID, name: 'new-site', url: 'https://new-site-cd34.pages.danubedata.ro' });
    mockGet
      .mockResolvedValueOnce({ data: [{ id: 1, name: 'My Team' }] })
      .mockResolvedValueOnce({ data: [] });
    mockSelect.mockResolvedValueOnce(''); // CREATE_NEW
    mockInput.mockResolvedValueOnce('  new-site ');
    mockPost.mockResolvedValueOnce({ message: 'Created', data: newSite });

    await linkCommand.parseAsync(['node', 'test']);

    expect(mockCreate).toHaveBeenLastCalledWith({ teamId: 1 });
    expect(mockPost).toHaveBeenCalledWith('/api/v1/teams/1/static-sites', { name: 'new-site' });
    expect(mockWriteProjectConfig).toHaveBeenCalledWith({
      siteId: NEW_SITE_ID,
      teamId: 1,
      siteName: 'new-site',
      siteUrl: 'https://new-site-cd34.pages.danubedata.ro',
    });
    expect(logged()).toContain('Created site');
  });

  it('prints the site ID and team a CI job needs', async () => {
    mockGet
      .mockResolvedValueOnce({ data: [{ id: 4, name: 'Safi' }] })
      .mockResolvedValueOnce({ data: [makeSite()] });
    mockSelect.mockResolvedValueOnce(SITE_ID);

    await linkCommand.parseAsync(['node', 'test']);

    expect(logged()).toContain(`DANUBE_SITE_ID=${SITE_ID} and DANUBE_TEAM_ID=4`);
  });

  it('throws when the selected site is not in the list', async () => {
    mockGet
      .mockResolvedValueOnce({ data: [{ id: 1, name: 'My Team' }] })
      .mockResolvedValueOnce({ data: [makeSite()] });
    mockSelect.mockResolvedValueOnce('01a0d8fa-ffff-7fff-8fff-ffffffffffff');

    await expect(linkCommand.parseAsync(['node', 'test'])).rejects.toThrow('Selected site not found');
  });

  it('validates site name input is not empty', async () => {
    const newSite = makeSite({ id: NEW_SITE_ID, name: 'valid', url: 'https://valid-ef56.pages.danubedata.ro' });
    mockGet
      .mockResolvedValueOnce({ data: [{ id: 1, name: 'My Team' }] })
      .mockResolvedValueOnce({ data: [] });
    mockSelect.mockResolvedValueOnce('');
    mockInput.mockImplementation(async (opts: { validate?: (v: string) => string | boolean }) => {
      // Test the validate callback
      if (opts.validate) {
        expect(opts.validate('')).toBe('Name is required');
        expect(opts.validate('  ')).toBe('Name is required');
        expect(opts.validate('ok')).toBe(true);
      }
      return 'valid';
    });
    mockPost.mockResolvedValueOnce({ message: 'Created', data: newSite });

    await linkCommand.parseAsync(['node', 'test']);

    expect(mockInput).toHaveBeenCalled();
  });
});
