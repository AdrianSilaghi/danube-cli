import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../lib/api-client.js';
import type { User, TeamsResponse } from '../types/api.js';

export const whoamiCommand = new Command('whoami')
  .description('Show current authenticated user')
  .action(async () => {
    const api = await ApiClient.create();

    const [user, teams] = await Promise.all([
      api.get<User>('/api/user'),
      api.get<TeamsResponse>('/api/v1/user/teams'),
    ]);

    console.log(chalk.bold(user.name));
    console.log(`Email: ${user.email}`);
    console.log(`Teams: ${teams.data.map(t => t.name).join(', ')}`);
  });
