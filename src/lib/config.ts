import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface DanubeConfig {
  token: string;
  apiBase?: string;
  teamId?: number;
  teamName?: string;
}

const CONFIG_DIR = join(homedir(), '.danube');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export function getApiBase(): string {
  return process.env.DANUBE_API_BASE || 'https://danubedata.ro';
}

export async function readConfig(): Promise<DanubeConfig | null> {
  let fileConfig: DanubeConfig | null = null;

  try {
    const raw = await readFile(CONFIG_FILE, 'utf-8');
    fileConfig = JSON.parse(raw) as DanubeConfig;
  } catch {
    // No config file
  }

  // Env var takes precedence for token
  const envToken = process.env.DANUBE_TOKEN;
  if (envToken) {
    return {
      ...fileConfig,
      token: envToken,
      apiBase: getApiBase(),
    };
  }

  return fileConfig;
}

export async function writeConfig(config: DanubeConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

export async function deleteConfig(): Promise<void> {
  try {
    await rm(CONFIG_FILE);
  } catch {
    // Ignore if file doesn't exist
  }
}

export function getToken(config: DanubeConfig | null): string | null {
  return process.env.DANUBE_TOKEN || config?.token || null;
}

export function getTeamId(config: DanubeConfig | null): number | null {
  const envTeamId = process.env.DANUBE_TEAM_ID;
  if (envTeamId) return Number(envTeamId);
  return config?.teamId ?? null;
}
