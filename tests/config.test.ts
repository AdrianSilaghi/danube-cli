import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// We need to mock homedir before importing config
const testDir = join(tmpdir(), `danube-test-${randomUUID()}`);

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => testDir };
});

const { readConfig, writeConfig, deleteConfig, getApiBase, getToken } = await import('../src/lib/config.js');

describe('config', () => {
  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    delete process.env.DANUBE_TOKEN;
    delete process.env.DANUBE_API_BASE;
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns null when no config exists', async () => {
    const config = await readConfig();
    expect(config).toBeNull();
  });

  it('writes and reads config', async () => {
    await writeConfig({ token: 'test-token-123' });
    const config = await readConfig();
    expect(config).toEqual({ token: 'test-token-123' });
  });

  it('deletes config', async () => {
    await writeConfig({ token: 'test-token-123' });
    await deleteConfig();
    const config = await readConfig();
    expect(config).toBeNull();
  });

  it('prefers env var over file', async () => {
    await writeConfig({ token: 'file-token' });
    process.env.DANUBE_TOKEN = 'env-token';
    const config = await readConfig();
    expect(config?.token).toBe('env-token');
  });

  it('getApiBase returns default', () => {
    expect(getApiBase()).toBe('https://danubedata.ro');
  });

  it('getApiBase respects env var', () => {
    process.env.DANUBE_API_BASE = 'http://localhost:8000';
    expect(getApiBase()).toBe('http://localhost:8000');
  });

  it('getToken returns null for empty config', () => {
    expect(getToken(null)).toBeNull();
  });

  it('getToken returns token from config', () => {
    expect(getToken({ token: 'abc' })).toBe('abc');
  });

  it('getToken prefers env var', () => {
    process.env.DANUBE_TOKEN = 'env-tk';
    expect(getToken({ token: 'cfg-tk' })).toBe('env-tk');
  });
});
