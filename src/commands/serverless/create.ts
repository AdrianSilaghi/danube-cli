import { Command } from 'commander';
import { select, input } from '@inquirer/prompts';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
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
  .option('--profile <profile>', 'Resource profile')
  .option('--port <port>', 'Container port', '8080')
  .option('--min-scale <n>', 'Minimum scale')
  .option('--max-scale <n>', 'Maximum scale')
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
    if (teams.length === 1) {
      teamId = teams[0]!.id;
      console.log(`Team: ${chalk.bold(teams[0]!.name)}`);
    } else {
      teamId = await select({
        message: 'Select a team:',
        choices: teams.map((t) => ({ name: t.name, value: t.id })),
      });
    }

    // Get name
    const name = opts.name || await input({
      message: 'Container name:',
      validate: (v: string) => v.trim().length > 0 || 'Name is required',
    });

    // Get deployment type
    let deploymentType = opts.type;
    if (!deploymentType) {
      deploymentType = await select({
        message: 'Deployment type:',
        choices: [
          { name: 'Docker Image', value: 'docker_image' },
          { name: 'Git Repository', value: 'git_repository' },
          { name: 'Local (ZIP upload)', value: 'zip_upload' },
        ],
      });
    }
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
    if (opts.profile) body.resource_profile = opts.profile;

    // Type-specific fields
    if (deploymentType === 'docker_image') {
      body.image = opts.image || await input({
        message: 'Docker image:',
        validate: (v: string) => v.trim().length > 0 || 'Image is required',
      });
      body.image_tag = opts.tag || await input({
        message: 'Image tag:',
        default: 'latest',
      });
    } else if (deploymentType === 'git_repository') {
      body.repository_url = opts.repo || await input({
        message: 'Git repository URL:',
        validate: (v: string) => v.trim().length > 0 || 'URL is required',
      });
      body.source_type = opts.sourceType || await select({
        message: 'Build type:',
        choices: [
          { name: 'Dockerfile', value: 'dockerfile' },
          { name: 'Buildpack', value: 'buildpack' },
        ],
      });
      body.git_auth_type = 'none';
    } else if (deploymentType === 'zip_upload') {
      body.source_type = opts.sourceType || await select({
        message: 'Build type:',
        choices: [
          { name: 'Dockerfile', value: 'dockerfile' },
          { name: 'Buildpack', value: 'buildpack' },
        ],
      });
    }

    // Get resource profile if not set
    if (!body.resource_profile) {
      body.resource_profile = await select({
        message: 'Resource profile:',
        choices: [
          { name: 'Free (0.01-0.1 vCPU, 64-128MB) - 2M req/mo included', value: 'free' },
          { name: 'Small (0.5-1 vCPU, 256-512MB) - pay per use', value: 'small' },
          { name: 'Medium (1-2 vCPU, 512MB-1GB) - pay per use', value: 'medium' },
          { name: 'Large (2-4 vCPU, 1-2GB) - pay per use', value: 'large' },
        ],
      });
    }

    const res = await api.post<ServerlessCreateResponse>('/api/v1/serverless', body);

    console.log(chalk.green(`\nCreated serverless container: ${chalk.bold(res.container.name)}`));
    console.log(`ID: ${res.container.id}`);
    console.log(`Status: ${res.container.status}`);

    if (deploymentType === 'zip_upload') {
      console.log(chalk.dim('\nDeploy your code with: danube serverless deploy ' + res.container.name + ' --dir ./src'));
    }
  });
