import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet, post: mockPost }),
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

const makeSite = (overrides = {}) => ({
  id: 1, team_id: 1, name: 'my-site', slug: 'my-site',
  default_domain: 'my-site.danubesites.ro', output_directory: null,
  status: 'active', current_deployment_id: null,
  created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('link command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGet.mockReset();
    mockPost.mockReset();
    mockSelect.mockReset();
    mockInput.mockReset();
    mockWriteProjectConfig.mockReset();
    mockWriteProjectConfig.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('auto-selects single team and links existing site', async () => {
    const site = makeSite();
    mockGet
      .mockResolvedValueOnce({ data: [{ id: 1, name: 'My Team' }] })
      .mockResolvedValueOnce({ data: [site] });
    mockSelect.mockResolvedValueOnce(1); // select existing site

    await linkCommand.parseAsync(['node', 'test']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('My Team'));
    expect(mockWriteProjectConfig).toHaveBeenCalledWith({
      siteId: 1,
      teamId: 1,
      siteName: 'my-site',
    });
  });

  it('prompts team selection when multiple teams', async () => {
    const site = makeSite();
    mockGet
      .mockResolvedValueOnce({
        data: [{ id: 1, name: 'Team A' }, { id: 2, name: 'Team B' }],
      })
      .mockResolvedValueOnce({ data: [site] });
    mockSelect
      .mockResolvedValueOnce(2)  // select Team B
      .mockResolvedValueOnce(1); // select existing site

    await linkCommand.parseAsync(['node', 'test']);

    expect(mockSelect).toHaveBeenCalledTimes(2);
    expect(mockGet).toHaveBeenCalledWith('/api/v1/teams/2/static-sites');
  });

  it('creates new site when selected', async () => {
    const newSite = makeSite({ id: 42, name: 'new-site', default_domain: 'new-site.danubesites.ro' });
    mockGet
      .mockResolvedValueOnce({ data: [{ id: 1, name: 'My Team' }] })
      .mockResolvedValueOnce({ data: [] });
    mockSelect.mockResolvedValueOnce(-1); // CREATE_NEW
    mockInput.mockResolvedValueOnce('new-site');
    mockPost.mockResolvedValueOnce({ message: 'Created', data: newSite });

    await linkCommand.parseAsync(['node', 'test']);

    expect(mockPost).toHaveBeenCalledWith(
      '/api/v1/teams/1/static-sites',
      { name: 'new-site' },
    );
    expect(mockWriteProjectConfig).toHaveBeenCalledWith({
      siteId: 42,
      teamId: 1,
      siteName: 'new-site',
    });
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Created site'));
  });

  it('validates site name input is not empty', async () => {
    const newSite = makeSite({ id: 10, name: 'valid', default_domain: 'valid.danubesites.ro' });
    mockGet
      .mockResolvedValueOnce({ data: [{ id: 1, name: 'My Team' }] })
      .mockResolvedValueOnce({ data: [] });
    mockSelect.mockResolvedValueOnce(-1);
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
