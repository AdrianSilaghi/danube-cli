import { Command } from 'commander';
import chalk from 'chalk';
import { isJsonMode, jsonEnvelope } from '../lib/json-mode.js';
import { readConfig, writeConfig } from '../lib/config.js';
import { UsageError } from '../lib/errors.js';
import { checkForUpdate, getCurrentVersion, PACKAGE_NAME } from '../lib/version.js';
import { detectInstall, explainRefusal, performUpgrade } from '../lib/upgrade.js';

/**
 * `danube upgrade` — the command the update notice points at.
 *
 * It exists so the notice can name ONE thing that works regardless of how the
 * CLI was installed. `npm install -g` is wrong under a version manager and
 * fails against a root-owned prefix; this detects both and says what to run
 * instead, rather than failing halfway through an install.
 */
export const upgradeCommand = new Command('upgrade')
  .description('Update the CLI to the latest published version')
  .option('--check', 'Report what would happen without installing anything')
  .action(async (opts: { check?: boolean }) => {
    const current = getCurrentVersion();
    const result = await checkForUpdate();

    if (result === null) {
      const message = 'Could not reach the npm registry to check for updates.';
      if (isJsonMode()) {
        jsonEnvelope({ current, latest: null, upgraded: false }, {
          error: { code: 'upgrade.check_failed', message, retryable: true },
        });
      } else {
        console.error(chalk.yellow(message));
      }
      process.exitCode = 1;

      return;
    }

    if (!result.updateAvailable) {
      if (isJsonMode()) {
        jsonEnvelope({ current, latest: result.latest, upgraded: false }, { meta: { up_to_date: true } });
      } else {
        console.log(`Already on the latest version (${chalk.bold(current)}).`);
      }

      return;
    }

    const install = await detectInstall();

    if (opts.check) {
      const canUpgrade = install.kind === 'npm-global';
      if (isJsonMode()) {
        jsonEnvelope({
          current,
          latest: result.latest,
          upgraded: false,
          is_major: result.isMajor,
          can_upgrade: canUpgrade,
          reason: canUpgrade ? null : explainRefusal(install),
        }, { meta: { install_kind: install.kind } });
      } else {
        console.log(`${current} → ${chalk.green(result.latest)}${result.isMajor ? chalk.red('  (MAJOR — breaking)') : ''}`);
        console.log(canUpgrade ? 'Ready to upgrade.' : chalk.yellow(explainRefusal(install)));
      }

      return;
    }

    // A major upgrade DOES install here — the user asked for it by name. What
    // it must not do is happen silently; that is the auto-update path, which
    // refuses majors outright.
    if (result.isMajor && !isJsonMode()) {
      console.log(chalk.yellow(`${current} → ${result.latest} is a MAJOR upgrade and may break existing scripts.`));
      console.log(chalk.dim('What changed: https://docs.danubedata.ro/failure-codes\n'));
    }

    const outcome = await performUpgrade(current, result.latest);

    if (isJsonMode()) {
      jsonEnvelope({
        current,
        latest: result.latest,
        upgraded: outcome.ok,
        is_major: result.isMajor,
      }, {
        error: outcome.ok ? null : { code: 'upgrade.failed', message: outcome.message, retryable: false },
      });
    } else {
      console.log(outcome.ok ? chalk.green(outcome.message) : chalk.red(outcome.message));
    }

    if (!outcome.ok) process.exitCode = 1;
  });

const KEYS = ['auto-update'] as const;

/**
 * `danube config` — deliberately tiny. It exists to hold the auto-update
 * switch, not to become a second home for settings that already live in
 * `danube project` or in environment variables.
 */
export const configCommand = new Command('config').description('Read and write CLI settings');

configCommand
  .command('set')
  .description(`Set a setting (${KEYS.join(', ')})`)
  .argument('<key>', KEYS.join(' | '))
  .argument('<value>', 'true or false')
  .action(async (key: string, value: string) => {
    if (!KEYS.includes(key as (typeof KEYS)[number])) {
      throw new UsageError(`Unknown setting "${key}". Known settings: ${KEYS.join(', ')}.`);
    }
    if (value !== 'true' && value !== 'false') {
      throw new UsageError(`Expected "true" or "false" for ${key}, got "${value}".`);
    }

    const config = await readConfig();
    if (config === null) {
      throw new UsageError('No CLI config found. Run `danube login` first.');
    }

    const enabled = value === 'true';
    await writeConfig({ ...config, autoUpdate: enabled });

    if (isJsonMode()) {
      jsonEnvelope({ key, value: enabled });

      return;
    }

    console.log(`auto-update ${enabled ? chalk.green('enabled') : chalk.yellow('disabled')}.`);
    if (enabled) {
      console.log(chalk.dim('Same-major updates install automatically after a command finishes.'));
      console.log(chalk.dim('Major upgrades are never installed for you — run `danube upgrade` for those.'));
    }
  });

configCommand
  .command('get')
  .description('Show current settings')
  .action(async () => {
    const config = await readConfig();
    const autoUpdate = config?.autoUpdate === true;

    if (isJsonMode()) {
      jsonEnvelope({ 'auto-update': autoUpdate, package: PACKAGE_NAME, version: getCurrentVersion() });

      return;
    }

    console.log(`auto-update  ${autoUpdate ? chalk.green('true') : chalk.dim('false')}`);
    console.log(`version      ${getCurrentVersion()}`);
  });
