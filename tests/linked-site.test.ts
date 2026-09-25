import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockCreate = vi.fn();
vi.mock('../src/lib/api-client.js', () => ({
  ApiClient: { create: (...args: unknown[]) => mockCreate(...args) },
}));

const mockReadProjectConfig = vi.fn();
vi.mock('../src/lib/project.js', () => ({
  readProjectConfig: () => mockReadProjectConfig(),
}));

const { openLinkedSite, resolveSiteProject } = await import('../src/lib/linked-site.js');
const { setProjectOverride } = await import('../src/lib/project-context.js');
const { ApiError, NotLinkedError, ResourceNotFoundError, UsageError } = await import('../src/lib/errors.js');

const SITE_ID = '01a0d8fa-35fa-709d-b9d1-319c28ba28fa';
const site = { id: SITE_ID, url: 'https://s-ab12.pages.danubedata.ro', deployment_count: 3, status: 'active', last_error: null };

describe('linked site', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockCreate.mockReset();
    mockReadProjectConfig.mockReset();
    mockCreate.mockResolvedValue({ get: mockGet });
    setProjectOverride(null);
  });

  afterEach(() => {
    setProjectOverride(null);
  });

  describe('resolveSiteProject', () => {
    it('uses the linked project', () => {
      expect(resolveSiteProject(4)).toBe(4);
    });

    it('accepts an explicit --project that agrees with the link', () => {
      setProjectOverride(4);
      expect(resolveSiteProject(4)).toBe(4);
    });

    /**
     * A site belongs to one project; a request scoped to another can only
     * 404. Refusing is better than silently picking either side.
     */
    it('refuses an explicit --project that contradicts the link', () => {
      setProjectOverride(20);
      expect(() => resolveSiteProject(4)).toThrow(UsageError);
      expect(() => resolveSiteProject(4)).toThrow(/belongs to project 4, but --project 20/);
    });

    it('falls back to --project, then the usual selection, for a link without a project', () => {
      expect(resolveSiteProject(null)).toBeNull();
      setProjectOverride(7);
      expect(resolveSiteProject(null)).toBe(7);
    });
  });

  describe('openLinkedSite', () => {
    it('throws NotLinkedError when nothing is linked', async () => {
      mockReadProjectConfig.mockResolvedValue(null);

      await expect(openLinkedSite()).rejects.toThrow(NotLinkedError);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    /**
     * The regression: every pages request was scoped to whichever project
     * `danube project use` selected last, not the one the site was linked in.
     */
    it("scopes the client to the site's project, not the selected one", async () => {
      mockReadProjectConfig.mockResolvedValue({ siteId: SITE_ID, teamId: 4, siteName: 's' });
      mockGet.mockResolvedValue({ data: site });

      const linked = await openLinkedSite();

      expect(mockCreate).toHaveBeenCalledWith({ teamId: 4 });
      expect(mockGet).toHaveBeenCalledWith(`/api/v1/static-sites/${SITE_ID}`);
      expect(linked.site).toEqual(site);
      expect(linked.project.siteId).toBe(SITE_ID);
    });

    it('explains a 404 instead of passing on a bare "Not Found"', async () => {
      mockReadProjectConfig.mockResolvedValue({ siteId: SITE_ID, teamId: 4, siteName: 's' });
      mockGet.mockRejectedValue(new ApiError(404, 'Not Found'));

      await expect(openLinkedSite()).rejects.toThrow(ResourceNotFoundError);
      await expect(openLinkedSite()).rejects.toThrow(/Static site 01a0d8fa-.* was not found in project 4\. .*danube pages link/);
    });

    it('leaves the project out of the 404 message when the link has none', async () => {
      mockReadProjectConfig.mockResolvedValue({ siteId: SITE_ID, teamId: null, siteName: 's' });
      mockGet.mockRejectedValue(new ApiError(404, 'Not Found'));

      await expect(openLinkedSite()).rejects.toThrow(/was not found\. It may/);
      expect(mockCreate).toHaveBeenCalledWith({ teamId: null });
    });

    it('passes other API errors through unchanged', async () => {
      mockReadProjectConfig.mockResolvedValue({ siteId: SITE_ID, teamId: 4, siteName: 's' });
      const forbidden = new ApiError(403, 'This token is scoped to a single project.');
      mockGet.mockRejectedValue(forbidden);

      await expect(openLinkedSite()).rejects.toBe(forbidden);
    });
  });
});
