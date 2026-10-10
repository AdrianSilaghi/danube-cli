import { Command } from 'commander';
import { password } from '@inquirer/prompts';
import chalk from 'chalk';
import { writeConfig, getApiBase } from '../lib/config.js';
import { ApiError } from '../lib/errors.js';
import { canPrompt, promptOr } from '../lib/interactive.js';
import { lockedTeamId } from '../lib/token-scope.js';
import { teamsArray } from '../types/api.js';
import type { Team, TeamsResponse, User } from '../types/api.js';

/**
 * The project a token made for "This project only" is locked to: it works
 * nowhere else, so it becomes the selected project at once. Undefined for a
 * token that works in every project, and when the teams cannot be read: the
 * login itself has already succeeded.
 */
async function lockedProject(apiBase: string, token: string): Promise<Team | undefined> {
  try {
    const res = await fetch(`${apiBase}/api/v1/user/teams`, {
      headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
      return undefined;
    }

    const teams = (await res.json()) as TeamsResponse;
    const locked = lockedTeamId(teams);

    return locked === null ? undefined : teamsArray(teams).find(t => t.id === locked);
  } catch {
    return undefined;
  }
}

export const loginCommand = new Command('login')
  .description('Authenticate with DanubeData')
  .option('--token <token>', 'API token (prefer DANUBE_TOKEN env var in CI to avoid shell history exposure)')
  .action(async (opts: { token?: string }) => {
    if (!opts.token && canPrompt()) {
      console.log(chalk.bold('Log in to DanubeData\n'));
      console.log(`Create an API token at: ${chalk.cyan(`${getApiBase()}/user/api-tokens`)}\n`);
    }

    let token = await promptOr('--token', opts.token, () => password({
      message: 'Paste your API token:',
      mask: '*',
    }));

    if (!token?.trim()) {
      console.error(chalk.red('No token provided.'));
      process.exit(1);
    }

    token = token.trim();

    // Validate token by calling /api/user
    try {
      const res = await fetch(`${getApiBase()}/api/user`, {
        headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!res.ok) {
        if (res.status === 401) {
          console.error(chalk.red('Invalid token.'));
          process.exit(1);
        }
        throw new ApiError(res.status, `Validation failed with status ${res.status}`);
      }

      const user = (await res.json()) as User;
      const apiBase = getApiBase();
      const config: { token: string; apiBase?: string } = { token };
      if (apiBase !== 'https://danubedata.ro') {
        config.apiBase = apiBase;
      }
      const locked = await lockedProject(apiBase, token);
      await writeConfig(locked ? { ...config, teamId: locked.id, teamName: locked.name } : config);

      console.log(chalk.green(`\nAuthenticated as ${chalk.bold(user.name)} (${user.email})`));
      if (locked) {
        console.log(`Selected project: ${chalk.bold(locked.name)} ${chalk.dim('(the only project this token works in)')}`);
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      console.error(chalk.red('Failed to connect to DanubeData API.'));
      process.exit(1);
    }
  });
