import { Command } from 'commander';
import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import { ApiClient } from '../lib/api-client.js';
import { readConfig, writeConfig } from '../lib/config.js';
import { isJsonMode, jsonOutput } from '../lib/json-mode.js';
import { canPrompt } from '../lib/interactive.js';
import { parseProjectId, getProjectOverride } from '../lib/project-context.js';
import { ApiError, MissingFlagsError, UsageError } from '../lib/errors.js';
import { assertTokenReaches, lockedTeamId } from '../lib/token-scope.js';
import { teamsArray } from '../types/api.js';
import type { TeamsResponse } from '../types/api.js';

/**
 * Your projects, asked without naming one, so a stale selection (a project the
 * token is refused in, or one you left) cannot block the command that replaces
 * it. The server then checks your default project instead. If that one refuses
 * the request (a blocked project, say), ask again in the selected project, as
 * versions before 1.8 did, so this is never worse than it was.
 */
async function listProjects(): Promise<TeamsResponse> {
  try {
    return await (await ApiClient.create({ unscoped: true })).get<TeamsResponse>('/api/v1/user/teams');
  } catch (error) {
    if (!(error instanceof ApiError) || error.statusCode !== 403) throw error;

    return (await ApiClient.create()).get<TeamsResponse>('/api/v1/user/teams');
  }
}

const lsCommand = new Command('ls')
  .description('List all projects (teams)')
  .action(async () => {
    const res = await listProjects();
    const teams = teamsArray(res);
    const locked = lockedTeamId(res);
    const config = await readConfig();

    if (isJsonMode()) {
      // Null when the server does not say what the token reaches (deployments before 2026-10).
      const reaches = (id: number): boolean | null => (res.token_team_id === undefined ? null : locked === null || locked === id);
      jsonOutput(teams.map(t => ({ ...t, selected: config?.teamId === t.id, token_reaches: reaches(t.id) })));
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
      const unreachable = locked !== null && locked !== team.id ? chalk.dim(' [not for this token]') : '';
      console.log(`  ${chalk.bold(team.name)}${personal}${marker}${unreachable}  ${chalk.dim(`id: ${team.id}`)}`);
    }
  });

const selectCommand = new Command('select')
  .description('Select a project to use for all commands')
  .option('--project <id>', 'Select this project id without prompting')
  .action(async (opts: { project?: string }) => {
    const res = await listProjects();
    const teams = teamsArray(res);
    const locked = lockedTeamId(res);

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
      assertTokenReaches(team.id, res, teams);

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

    // A token locked to one project works nowhere else, so there is nothing to choose.
    const only = locked !== null ? teams.find(t => t.id === locked) : (teams.length === 1 ? teams[0] : undefined);

    if (only !== undefined) {
      const team = only;
      const config = await readConfig();
      if (config) {
        await writeConfig({ ...config, teamId: team.id, teamName: team.name });
      }
      if (isJsonMode()) {
        jsonOutput({ id: team.id, name: team.name });
        return;
      }
      console.log(`Selected project: ${chalk.bold(team.name)}${locked !== null ? chalk.dim(' (the only project this token works in)') : ''}`);
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
