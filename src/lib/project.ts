import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { UsageError } from './errors.js';
import { parseProjectId } from './project-context.js';

export interface ProjectConfig {
  /** The static site's ID — a UUID, exactly as the API returns it. */
  siteId: string;
  /**
   * The project (team) the site belongs to. Every request about the site is
   * scoped to it. `null` only for a CI link without DANUBE_TEAM_ID, which then
   * falls back to the ordinary project selection.
   */
  teamId: number | null;
  siteName: string;
  siteUrl?: string;
  /** @deprecated Use siteUrl instead */
  defaultDomain?: string;
}

export interface DanubeJson {
  outputDir?: string;
  ignore?: string[];
}

const PROJECT_DIR = '.danube';
const PROJECT_FILE = 'project.json';
const DANUBE_JSON = 'danube.json';

const SITE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A static site ID, validated before it reaches a URL.
 *
 * Site IDs have always been UUIDs. This used to be `parseInt`, which read the
 * UUID `01a0d8fa-…` as the site `1` — so every CI deploy went to a 404 — and
 * rejected any ID starting with a letter as "not a positive integer".
 */
export function parseSiteId(value: string): string {
  const raw = value.trim();

  if (!SITE_ID_PATTERN.test(raw)) {
    throw new UsageError(
      `DANUBE_SITE_ID must be a static site ID (a UUID such as 01a0d8fa-35fa-709d-b9d1-319c28ba28fa), got "${raw}". `
      + 'Run `danube pages link` once and copy "siteId" from .danube/project.json.',
    );
  }

  return raw.toLowerCase();
}

function parseTeamId(value: string): number {
  try {
    return parseProjectId(value);
  } catch {
    throw new UsageError(`DANUBE_TEAM_ID must be a project ID (a positive integer), got "${value}".`);
  }
}

/**
 * The CI link. DANUBE_SITE_ID names the site; DANUBE_TEAM_ID, when set, names
 * its project. DANUBE_TEAM_ID on its own is not a link — it is the ordinary
 * project selection that every command honours.
 */
function readEnvLink(): ProjectConfig | null {
  const envSiteId = process.env.DANUBE_SITE_ID;
  if (!envSiteId) return null;

  const envTeamId = process.env.DANUBE_TEAM_ID;

  return {
    siteId: parseSiteId(envSiteId),
    teamId: envTeamId ? parseTeamId(envTeamId) : null,
    siteName: process.env.DANUBE_SITE_NAME || 'unknown',
  };
}

export async function readProjectConfig(cwd: string = process.cwd()): Promise<ProjectConfig | null> {
  const envLink = readEnvLink();
  if (envLink) return envLink;

  const file = join(cwd, PROJECT_DIR, PROJECT_FILE);
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch {
    return null;
  }

  // A broken link file is reported as broken. Treating it as "not linked"
  // sent people to `danube pages link` without saying what was wrong.
  let parsed: Partial<ProjectConfig> & { siteId?: unknown; teamId?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new UsageError(`${PROJECT_DIR}/${PROJECT_FILE} is not valid JSON. Run \`danube pages link\` to recreate it.`);
  }

  if (typeof parsed.siteId !== 'string' || parsed.siteId === '') {
    throw new UsageError(`${PROJECT_DIR}/${PROJECT_FILE} has no siteId. Run \`danube pages link\` to recreate it.`);
  }

  return {
    ...parsed,
    siteId: parsed.siteId,
    teamId: typeof parsed.teamId === 'number' ? parsed.teamId : null,
    siteName: parsed.siteName ?? 'unknown',
  };
}

export async function writeProjectConfig(config: ProjectConfig, cwd: string = process.cwd()): Promise<void> {
  const dir = join(cwd, PROJECT_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, PROJECT_FILE), JSON.stringify(config, null, 2) + '\n');
}

export async function readDanubeJson(cwd: string = process.cwd()): Promise<DanubeJson | null> {
  try {
    const raw = await readFile(join(cwd, DANUBE_JSON), 'utf-8');
    return JSON.parse(raw) as DanubeJson;
  } catch {
    return null;
  }
}
