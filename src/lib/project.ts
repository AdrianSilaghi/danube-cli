import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface ProjectConfig {
  siteId: number;
  teamId: number;
  siteName: string;
}

export interface DanubeJson {
  outputDir?: string;
  ignore?: string[];
}

const PROJECT_DIR = '.danube';
const PROJECT_FILE = 'project.json';
const DANUBE_JSON = 'danube.json';

export async function readProjectConfig(cwd: string = process.cwd()): Promise<ProjectConfig | null> {
  // Env var fallback for CI
  const envSiteId = process.env.DANUBE_SITE_ID;
  const envTeamId = process.env.DANUBE_TEAM_ID;
  if (envSiteId && envTeamId) {
    return {
      siteId: Number(envSiteId),
      teamId: Number(envTeamId),
      siteName: process.env.DANUBE_SITE_NAME || 'unknown',
    };
  }

  try {
    const raw = await readFile(join(cwd, PROJECT_DIR, PROJECT_FILE), 'utf-8');
    return JSON.parse(raw) as ProjectConfig;
  } catch {
    return null;
  }
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
