import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface DanubeConfig {
  token: string;
  apiBase?: string;
}

const CONFIG_DIR = join(homedir(), '.danube');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export function getApiBase(): string {
  return process.env.DANUBE_API_BASE || 'https://danubedata.ro';
}

export async function readConfig(): Promise<DanubeConfig | null> {
  // Env var takes precedence
  const envToken = process.env.DANUBE_TOKEN;
  if (envToken) {
    return { token: envToken, apiBase: getApiBase() };
  }

  try {
    const raw = await readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as DanubeConfig;
  } catch {
    return null;
  }
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
