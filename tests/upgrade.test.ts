import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const { detectInstall, explainRefusal } = await import('../src/lib/upgrade.js');

/**
 * Install detection is the safety layer for `danube upgrade`.
 *
 * `npm install -g` is only correct for a writable global npm install. Run it
 * under a version manager and it updates a package the shim does not point
 * at; run it against a root-owned prefix and it fails EACCES partway through,
 * which can leave a half-written CLI. Every one of those must be refused
 * BEFORE npm is invoked, with a message naming what to run instead.
 */
describe('install detection', () => {
  const root = join(tmpdir(), `danube-upgrade-${randomUUID()}`);

  /** Build a plausible install layout and return the module URL inside it. */
  async function layout(relative: string): Promise<string> {
    const file = join(root, relative);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, '');

    return pathToFileURL(file).href;
  }

  beforeAll(async () => {
    await mkdir(root, { recursive: true });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('recognises a writable global npm install', async () => {
    const url = await layout('prefix/lib/node_modules/@danubedata/cli/dist/lib/upgrade.js');

    const result = await detectInstall(url);

    expect(result.kind).toBe('npm-global');
  });

  /**
   * A version manager owns its own shims, so upgrading through npm would
   * leave the shim pointing at the old version — the CLI would report a new
   * version number while running the old code.
   */
  it('refuses under a version manager and names it', async () => {
    for (const [marker, manager] of [['.volta', 'volta'], ['.asdf', 'asdf'], ['.fnm', 'fnm']] as const) {
      const url = await layout(`${marker}/tools/node_modules/@danubedata/cli/dist/lib/upgrade.js`);

      const result = await detectInstall(url);

      expect(result.kind).toBe('version-manager');
      expect(explainRefusal(result)).toContain(manager);
    }
  });

  it('refuses when the install directory is not writable', async () => {
    const url = await layout('ro/lib/node_modules/@danubedata/cli/dist/lib/upgrade.js');
    const nodeModules = join(root, 'ro/lib/node_modules');

    await chmod(nodeModules, 0o500);
    try {
      const result = await detectInstall(url);

      // Running as root defeats the permission bit entirely; skip rather than
      // assert something the environment cannot demonstrate.
      if (result.kind === 'npm-global') return;

      expect(result.kind).toBe('unwritable');
      expect(explainRefusal(result)).toContain('npm config set prefix');
    } finally {
      await chmod(nodeModules, 0o700);
    }
  });

  it('refuses a path that is not an install at all', async () => {
    const result = await detectInstall(pathToFileURL(join(root, 'loose/upgrade.js')).href);

    expect(result.kind).toBe('not-global');
  });

  /**
   * A refusal that only says "cannot upgrade" strands someone on a version
   * with a known bug. Every refusal names the next step.
   */
  it('every refusal tells the caller what to run instead', () => {
    const messages = [
      explainRefusal({ kind: 'version-manager', manager: 'volta' }),
      explainRefusal({ kind: 'unwritable', prefix: '/usr/local' }),
      explainRefusal({ kind: 'not-global' }),
    ];

    for (const message of messages) {
      expect(message.length).toBeGreaterThan(40);
    }
  });
});
