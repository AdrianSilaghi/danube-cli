import { execFile } from 'node:child_process';
import { access, constants, realpath } from 'node:fs/promises';
import { dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PACKAGE_NAME } from './version.js';

const run = promisify(execFile);

/**
 * Upgrading a globally-installed CLI from inside itself.
 *
 * This is a module rather than one `npm install -g` call because that command
 * is only correct for a *writable global npm install*. Run it under a version
 * manager and it updates a package the shim does not point at; run it against
 * a root-owned prefix and it fails EACCES partway through, which can leave a
 * half-written install. So the install is refused unless we can show it will
 * work — and the refusal names the command that will.
 */

export type InstallKind =
  | { kind: 'npm-global'; prefix: string }
  | { kind: 'version-manager'; manager: string }
  | { kind: 'not-global' }
  | { kind: 'unwritable'; prefix: string };

/** Path markers for tools that own their own shims. */
const VERSION_MANAGERS: ReadonlyArray<readonly [string, string]> = [
  ['.volta', 'volta'],
  ['.asdf', 'asdf'],
  ['.fnm', 'fnm'],
  ['fnm_multishells', 'fnm'],
];

/**
 * Where this CLI actually lives, and whether we may write there.
 *
 * `realpath` first because npm links the bin: the argv path is a symlink into
 * the package, and the *package* location is what decides writability.
 */
export async function detectInstall(moduleUrl: string = import.meta.url): Promise<InstallKind> {
  let here: string;
  try {
    here = await realpath(fileURLToPath(moduleUrl));
  } catch {
    return { kind: 'not-global' };
  }

  for (const [marker, manager] of VERSION_MANAGERS) {
    if (here.includes(`${sep}${marker}${sep}`) || here.includes(marker)) {
      return { kind: 'version-manager', manager };
    }
  }

  // .../<prefix>/lib/node_modules/@danubedata/cli/dist/lib/upgrade.js
  const marker = `${sep}node_modules${sep}`;
  const at = here.lastIndexOf(marker);
  if (at === -1) return { kind: 'not-global' };

  const nodeModules = here.slice(0, at + marker.length - 1);
  const prefix = dirname(nodeModules);

  try {
    await access(nodeModules, constants.W_OK);
  } catch {
    return { kind: 'unwritable', prefix };
  }

  return { kind: 'npm-global', prefix };
}

/**
 * Why we will not upgrade, phrased as what to run instead. A bare "cannot
 * upgrade" leaves someone stuck on a version with a known bug.
 */
export function explainRefusal(install: InstallKind): string {
  switch (install.kind) {
    case 'version-manager':
      return `This CLI is managed by ${install.manager}, which owns its own shims — `
        + `upgrading through npm would leave ${install.manager} pointing at the old version. `
        + `Use ${install.manager}'s own install command for ${PACKAGE_NAME}.`;
    case 'unwritable':
      return `No write permission for ${install.prefix}. Either re-run with elevated permissions, `
        + `or (better) use a user-owned npm prefix so global installs never need root:\n`
        + `  npm config set prefix ~/.npm-global`;
    case 'not-global':
      return 'This does not look like a global install, so there is nothing for the CLI to upgrade. '
        + 'If it is a project dependency, update it with your package manager.';
    default:
      return '';
  }
}

export interface UpgradeOutcome {
  ok: boolean;
  from: string;
  to: string;
  message: string;
}

/**
 * Install a specific version. Pinned rather than `@latest` so the version we
 * announced is the version that lands — `latest` can move between the check
 * and the install.
 */
export async function performUpgrade(from: string, to: string): Promise<UpgradeOutcome> {
  const install = await detectInstall();

  if (install.kind !== 'npm-global') {
    return { ok: false, from, to, message: explainRefusal(install) };
  }

  try {
    await run('npm', ['install', '-g', `${PACKAGE_NAME}@${to}`], {
      timeout: 120_000,
      windowsHide: true,
    });

    return { ok: true, from, to, message: `Upgraded ${from} → ${to}` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);

    return {
      ok: false,
      from,
      to,
      message: `npm install failed: ${detail.split('\n')[0]}\n`
        + `Run it yourself to see the full output:\n  npm install -g ${PACKAGE_NAME}@${to}`,
    };
  }
}
