import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../lib/api-client.js';
import { isJsonMode, jsonOutput } from '../lib/json-mode.js';
import { teamsArray } from '../types/api.js';
import type { User, TeamsResponse } from '../types/api.js';

export const whoamiCommand = new Command('whoami')
  .description('Show current authenticated user')
  .action(async () => {
    const api = await ApiClient.create();

    const [user, teamsRes] = await Promise.all([
      api.get<User>('/api/user'),
      api.get<TeamsResponse>('/api/v1/user/teams'),
    ]);

    const teams = teamsArray(teamsRes);

    if (isJsonMode()) {
      jsonOutput({ user, teams, current_team_id: teamsRes.current_team_id });
      return;
    }

    console.log(chalk.bold(user.name));
    console.log(`Email: ${user.email}`);
    console.log(`Teams: ${teams.map(t => t.name).join(', ')}`);
  });
