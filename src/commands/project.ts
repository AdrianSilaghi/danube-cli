import { Command } from 'commander';
import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import { ApiClient } from '../lib/api-client.js';
import { readConfig, writeConfig } from '../lib/config.js';
import { isJsonMode, jsonOutput } from '../lib/json-mode.js';
import { canPrompt } from '../lib/interactive.js';
import { parseProjectId, getProjectOverride } from '../lib/project-context.js';
import { MissingFlagsError, UsageError } from '../lib/errors.js';
import { teamsArray } from '../types/api.js';
import type { TeamsResponse } from '../types/api.js';

const lsCommand = new Command('ls')
  .description('List all projects (teams)')
  .action(async () => {
    const api = await ApiClient.create();
    const res = await api.get<TeamsResponse>('/api/v1/user/teams');
    const teams = teamsArray(res);
    const config = await readConfig();

    if (isJsonMode()) {
      jsonOutput(teams.map(t => ({ ...t, selected: config?.teamId === t.id })));
      return;
    }

    if (teams.length === 0) {
      console.log('No projects found.');
      return;
    }

    for (const team of teams) {
      const isCurrent = config?.teamId === team.id;
      const marker = isCurrent ? chalk.green(' (selected)') : '';
      const personal = team.personal_team ? chalk.dim(' [personal]') : '';
      console.log(`  ${chalk.bold(team.name)}${personal}${marker}  ${chalk.dim(`id: ${team.id}`)}`);
    }
  });

const selectCommand = new Command('select')
  .description('Select a project to use for all commands')
  .option('--project <id>', 'Select this project id without prompting')
  .action(async (opts: { project?: string }) => {
    const api = await ApiClient.create();
    const res = await api.get<TeamsResponse>('/api/v1/user/teams');
    const teams = teamsArray(res);

    if (teams.length === 0) {
      console.log('No projects found.');
      return;
    }

    // Explicit selection: no prompt, ever. `project select` is the one command
    // automation must be able to run to establish context, so it cannot depend
    // on a TTY. The id is checked against actual membership rather than written
    // blind — persisting a project the account cannot reach would turn every
    // later command into a confusing 403.
    const requested = opts.project !== undefined ? parseProjectId(opts.project) : getProjectOverride();

    if (requested !== null) {
      const team = teams.find(t => t.id === requested);
      if (!team) {
        throw new UsageError(
          `Project ${requested} is not one of your projects. Run \`danube project ls\` to see the available ids.`,
        );
      }

      const existing = await readConfig();
      if (existing) {
        await writeConfig({ ...existing, teamId: team.id, teamName: team.name });
      }

      if (isJsonMode()) {
        jsonOutput({ id: team.id, name: team.name });
        return;
      }
      console.log(`Selected project: ${chalk.bold(team.name)}`);
      return;
    }

    if (teams.length === 1) {
      const team = teams[0]!;
      const config = await readConfig();
      if (config) {
        await writeConfig({ ...config, teamId: team.id, teamName: team.name });
      }
      if (isJsonMode()) {
        jsonOutput({ id: team.id, name: team.name });
        return;
      }
      console.log(`Selected project: ${chalk.bold(team.name)}`);
      return;
    }

    if (!canPrompt()) {
      // Non-interactive callers now have a real path forward rather than a
      // dead end: name the flag that would have worked.
      throw new MissingFlagsError(['--project']);
    }

    const config = await readConfig();

    const teamId = await select({
      message: 'Select a project:',
      choices: teams.map(t => ({
        name: `${t.name}${t.personal_team ? ' [personal]' : ''}`,
        value: t.id,
      })),
      default: config?.teamId,
    });

    const team = teams.find(t => t.id === teamId)!;

    if (config) {
      await writeConfig({ ...config, teamId: team.id, teamName: team.name });
    }

    if (isJsonMode()) {
      jsonOutput({ id: team.id, name: team.name });
      return;
    }
    console.log(`Selected project: ${chalk.bold(team.name)}`);
  });

const currentCommand = new Command('current')
  .description('Show the currently selected project')
  .action(async () => {
    const config = await readConfig();

    if (isJsonMode()) {
      jsonOutput({ team_id: config?.teamId ?? null, team_name: config?.teamName ?? null });
      return;
    }

    if (!config?.teamId) {
      console.log('No project selected. Run `danube project select` to choose one.');
      return;
    }

    console.log(`Current project: ${chalk.bold(config.teamName ?? `Team ${config.teamId}`)}`);
    console.log(`Team ID: ${config.teamId}`);
  });

const clearCommand = new Command('clear')
  .description('Clear the selected project (use server default)')
  .action(async () => {
    const config = await readConfig();
    if (config) {
      const { teamId: _, teamName: __, ...rest } = config;
      await writeConfig(rest as typeof config);
    }

    if (isJsonMode()) {
      jsonOutput({ status: 'cleared' });
      return;
    }
    console.log('Project selection cleared. Commands will use your default project.');
  });

export const projectCommand = new Command('project')
  .description('Manage project (team) selection')
  .addCommand(lsCommand)
  .addCommand(selectCommand)
  .addCommand(currentCommand)
  .addCommand(clearCommand);
