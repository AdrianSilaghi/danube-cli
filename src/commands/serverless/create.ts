import { Command } from 'commander';
import { select, input } from '@inquirer/prompts';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { resolveAlias } from '../../lib/flag-alias.js';
import { getProjectOverride } from '../../lib/project-context.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import { promptOr } from '../../lib/interactive.js';
import { waitForTerminal, DEFAULT_WAIT_TIMEOUT_MS } from '../../lib/wait-for-terminal.js';
import type { WaitResult } from '../../lib/wait-for-terminal.js';
import { teamsArray } from '../../types/api.js';
import type { TeamsResponse, ServerlessCreateResponse } from '../../types/api.js';

export const createCommand = new Command('create')
  .description('Create a new serverless container')
  .option('--name <name>', 'Container name')
  .option('--type <type>', 'Deployment type (docker_image, git_repository, local)')
  .option('--image <image>', 'Docker image')
  .option('--tag <tag>', 'Image tag')
  .option('--repo <url>', 'Git repository URL')
  .option('--source-type <type>', 'Source type for builds (dockerfile, buildpack)')
  // Canonical name matches the API field; --profile stays for humans.
  .option('--resource-profile <profile>', 'Resource profile (canonical)')
  .option('--profile <profile>', 'Alias for --resource-profile')
  .option('--port <port>', 'Container port', '8080')
  .option('--min-scale <n>', 'Minimum scale')
  .option('--max-scale <n>', 'Maximum scale')
  .option('--health-check-path <path>', 'Readiness probe path, e.g. /healthz')
  .option('--registry-credential <id>', 'Registry credential UUID (omit for images in your own team namespace)')
  .option('--wait', 'Block until the container reaches a terminal state, then report it')
  .option('--wait-timeout <duration>', 'Ceiling for --wait: 30s, 10m, 1h (default 10m)')
  .option('--team <id>', 'Team ID (required with multiple teams in non-interactive mode)')
  .action(async (opts) => {
    const api = await ApiClient.create();

    const parseIntOption = (val: string, name: string): number => {
      const n = parseInt(val, 10);
      if (isNaN(n)) {
        console.error(chalk.red(`Invalid value for ${name}: '${val}' is not an integer.`));
        process.exit(1);
      }
      return n;
    };

    // Select team
    const teamsRes = await api.get<TeamsResponse>('/api/v1/user/teams');
    const teams = teamsArray(teamsRes);

    let teamId: number;
    // `--project` is the canonical selector and already scopes the request via
    // X-Team-Id; honour it here too, or this command would still demand the
    // legacy `--team` in non-interactive mode despite having been told exactly
    // which project to use.
    const selectedProject = getProjectOverride();
    if (opts.team) {
      teamId = parseIntOption(opts.team, 'team');
    } else if (selectedProject !== null) {
      teamId = selectedProject;
    } else if (teams.length === 1) {
      teamId = teams[0]!.id;
      if (!isJsonMode()) console.log(`Team: ${chalk.bold(teams[0]!.name)}`);
    } else {
      teamId = await promptOr('--team', undefined, () => select({
        message: 'Select a team:',
        choices: teams.map((t) => ({ name: t.name, value: t.id })),
      }));
    }

    // Get name
    const name = await promptOr('--name', opts.name, () => input({
      message: 'Container name:',
      validate: (v: string) => v.trim().length > 0 || 'Name is required',
    }));

    // Get deployment type
    let deploymentType = await promptOr('--type', opts.type, () => select({
      message: 'Deployment type:',
      choices: [
        { name: 'Docker Image', value: 'docker_image' },
        { name: 'Git Repository', value: 'git_repository' },
        { name: 'Local (ZIP upload)', value: 'zip_upload' },
      ],
    }));
    if (deploymentType === 'local') deploymentType = 'zip_upload';

    // Build request body
    const body: Record<string, unknown> = {
      team_id: teamId,
      name: name.trim(),
      deployment_type: deploymentType,
      port: parseIntOption(opts.port, 'port'),
    };

    if (opts.minScale !== undefined) body.min_scale = parseIntOption(opts.minScale, 'min-scale');
    if (opts.maxScale !== undefined) body.max_scale = parseIntOption(opts.maxScale, 'max-scale');
    const resourceProfile = resolveAlias('resource-profile', [
      ['--resource-profile', opts.resourceProfile],
      ['--profile', opts.profile],
    ]);
    if (resourceProfile) body.resource_profile = resourceProfile;
    if (opts.healthCheckPath !== undefined) body.health_check_path = opts.healthCheckPath;
    // First-party images (cr.danubedata.ro/{your-namespace}/...) authenticate
    // through a credential the platform manages, so this is only for images in
    // someone else's registry.
    if (opts.registryCredential !== undefined) body.registry_credential_id = opts.registryCredential;

    // Type-specific fields
    if (deploymentType === 'docker_image') {
      body.image = await promptOr('--image', opts.image, () => input({
        message: 'Docker image:',
        validate: (v: string) => v.trim().length > 0 || 'Image is required',
      }));
      body.image_tag = await promptOr('--tag', opts.tag, () => input({
        message: 'Image tag:',
        default: 'latest',
      }));
    } else if (deploymentType === 'git_repository') {
      body.repository_url = await promptOr('--repo', opts.repo, () => input({
        message: 'Git repository URL:',
        validate: (v: string) => v.trim().length > 0 || 'URL is required',
      }));
      body.source_type = await promptOr('--source-type', opts.sourceType, () => select({
        message: 'Build type:',
        choices: [
          { name: 'Dockerfile', value: 'dockerfile' },
          { name: 'Buildpack', value: 'buildpack' },
        ],
      }));
      body.git_auth_type = 'none';
    } else if (deploymentType === 'zip_upload') {
      body.source_type = await promptOr('--source-type', opts.sourceType, () => select({
        message: 'Build type:',
        choices: [
          { name: 'Dockerfile', value: 'dockerfile' },
          { name: 'Buildpack', value: 'buildpack' },
        ],
      }));
    }

    // Get resource profile if not set
    if (!body.resource_profile) {
      body.resource_profile = await promptOr('--resource-profile', resourceProfile, () => select({
        message: 'Resource profile:',
        choices: [
          { name: 'Free (0.01-0.1 vCPU, 64-128MB) - 2M req/mo included', value: 'free' },
          { name: 'Small (0.5-1 vCPU, 256-512MB) - pay per use', value: 'small' },
          { name: 'Medium (1-2 vCPU, 512MB-1GB) - pay per use', value: 'medium' },
          { name: 'Large (2-4 vCPU, 1-2GB) - pay per use', value: 'large' },
        ],
      }));
    }

    // Free tier has a max_replicas limit of 3
    if (body.resource_profile === 'free' && body.max_scale === undefined) {
      body.max_scale = 3;
    }

    const res = await api.post<ServerlessCreateResponse>('/api/v1/serverless', body);

    if (!opts.wait) {
      if (isJsonMode()) {
        jsonOutput(res.container);
        return;
      }
      console.log(chalk.green(`\nCreated serverless container: ${chalk.bold(res.container.name)}`));
      console.log(`ID: ${res.container.id}`);
      console.log(`Status: ${res.container.status}`);

      if (deploymentType === 'zip_upload') {
        console.log(chalk.dim('\nDeploy your code with: danube rapids deploy ' + res.container.name + ' --dir ./src'));
      }
      return;
    }

    // --wait. Progress goes to stderr so `--json` output stays a clean document
    // on stdout that a caller can pipe straight into a parser.
    if (!isJsonMode()) {
      console.error(chalk.dim(`Created ${res.container.name} (${res.container.id}); waiting for a terminal state...`));
    }

    const wait = await waitForTerminal(api, res.container.id, {
      timeoutMs: parseDuration(opts.waitTimeout, 'wait-timeout') ?? DEFAULT_WAIT_TIMEOUT_MS,
    });

    if (isJsonMode()) {
      jsonOutput({ ...res.container, status_details: wait.status, url: wait.url, waited: wait.settled });
    } else {
      reportWait(wait, res.container.name);
    }

    // Exit non-zero only on a settled failure. A timeout is NOT a failure — the
    // deploy is still in flight — and `degraded` means an older revision is
    // still serving, so the site is up. Conflating either with "broken" is what
    // makes a CI pipeline roll back a healthy deployment.
    if (wait.settled && (wait.status?.summary === 'failed' || wait.status?.health === 'unhealthy')) {
      process.exitCode = 1;
    }
  });

/** `30s` / `10m` / `1h` -> milliseconds. */
function parseDuration(value: string | undefined, flag: string): number | null {
  if (value === undefined) return null;
  const m = /^(\d+)([smh])$/.exec(value.trim());
  if (!m) {
    console.error(chalk.red(`Invalid --${flag}: '${value}'. Use a duration like 30s, 10m or 1h.`));
    process.exit(1);
  }
  const n = parseInt(m[1]!, 10);
  return n * ({ s: 1_000, m: 60_000, h: 3_600_000 }[m[2]!] ?? 1_000);
}

function reportWait(wait: WaitResult, name: string): void {
  const secs = Math.round(wait.waitedMs / 1000);

  if (!wait.settled && wait.status === null) {
    console.error(chalk.yellow(
      `Created ${name}, but this platform does not report status_details, so --wait cannot poll it.\n` +
      `Check with: danube rapids get ${name} --json`,
    ));
    return;
  }

  if (!wait.settled) {
    console.error(chalk.yellow(
      `Still deploying after ${secs}s (${wait.status?.summary}). This is not a failure — the rollout continues.\n` +
      `Keep watching with: danube rapids get ${name} --json`,
    ));
    return;
  }

  const s = wait.status!;
  if (s.summary === 'ready') {
    console.log(chalk.green(`Ready in ${secs}s`));
    if (wait.url) console.log(`URL: ${wait.url}`);
    return;
  }

  if (s.summary === 'degraded') {
    console.log(chalk.yellow(`Degraded after ${secs}s — the new revision failed, an older one is still serving.`));
    if (wait.url) console.log(`URL: ${wait.url}`);
  } else {
    console.log(chalk.red(`${s.summary} after ${secs}s`));
  }

  if (s.error) {
    console.log(`  ${chalk.bold(s.error.code)}${s.error.retryable ? chalk.dim(' (retryable)') : ''}`);
    if (s.error.message) console.log(`  ${s.error.message}`);
    if (!s.error.retryable) {
      console.log(chalk.dim('  Retrying will fail the same way — fix the cause first.'));
    }
  }
  console.log(chalk.dim(`  Diagnose with: danube rapids revisions ${name} --json`));
}
