import { ApiClient } from './api-client.js';
import { ApiError, NotLinkedError, ResourceNotFoundError, UsageError } from './errors.js';
import { getProjectOverride } from './project-context.js';
import { readProjectConfig, type ProjectConfig } from './project.js';
import type { StaticSite } from '../types/api.js';

export interface LinkedSite {
  project: ProjectConfig;
  /** Scoped to the project the site belongs to. */
  api: ApiClient;
  /** The site as the API reports it now — its URL, status and revision count. */
  site: StaticSite;
}

/**
 * The project every request about the linked site has to be scoped to.
 *
 * A site belongs to exactly one project, and the API answers a request scoped
 * to any other with a 404. `danube pages link` asks which project to use and
 * records it, but the answer was then ignored: requests went out scoped to
 * whatever `danube project use` had selected last, so a site linked in one
 * project could not be deployed while another was selected.
 *
 * An explicit `--project` naming a different project can never succeed, so it
 * is reported rather than silently overridden in either direction.
 */
export function resolveSiteProject(linkedTeamId: number | null): number | null {
  const explicit = getProjectOverride();

  if (linkedTeamId === null) return explicit;

  if (explicit !== null && explicit !== linkedTeamId) {
    throw new UsageError(
      `The linked site belongs to project ${linkedTeamId}, but --project ${explicit} was given. `
      + 'Drop --project — pages commands use the linked site\'s project — or run `danube pages link` to link a different site.',
    );
  }

  return linkedTeamId;
}

/**
 * Everything a `danube pages` command needs: the link, a client scoped to the
 * site's project, and the site itself.
 *
 * Reading the site up front turns a stale or wrong link into an explanation
 * instead of a bare "API Error (404): Not Found" halfway through a deploy.
 */
export async function openLinkedSite(): Promise<LinkedSite> {
  const project = await readProjectConfig();
  if (!project) throw new NotLinkedError();

  const teamId = resolveSiteProject(project.teamId);
  const api = await ApiClient.create({ teamId });

  try {
    const res = await api.get<{ data: StaticSite }>(`/api/v1/static-sites/${project.siteId}`);

    return { project, api, site: res.data };
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 404) {
      const where = teamId === null ? '' : ` in project ${teamId}`;
      throw new ResourceNotFoundError(
        `Static site ${project.siteId} was not found${where}. `
        + 'It may have been deleted, or linked from another project — run `danube pages link` to link it again.',
      );
    }
    throw err;
  }
}
