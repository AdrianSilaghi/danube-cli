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

    // The registry namespace is printed here because it cannot be derived from
    // anything else the user can see: a team named "Safi" owns `safi4`. Without
    // it the first `docker push` is a guess, and a wrong guess fails as an
    // opaque "denied: requested access to the resource is denied".
    const current = teams.find(t => t.id === teamsRes.current_team_id);
    if (current?.registry_namespace) {
      console.log(`Project: ${current.name} (id ${current.id})`);
      console.log(`Registry namespace: ${chalk.cyan(current.registry_namespace)}`);
      console.log(chalk.dim(`  push to cr.danubedata.ro/${current.registry_namespace}/<repo>:<tag>`));
    }
  });
