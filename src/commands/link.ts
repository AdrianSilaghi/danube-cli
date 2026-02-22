import { Command } from 'commander';
import { select, input } from '@inquirer/prompts';
import chalk from 'chalk';
import { ApiClient } from '../lib/api-client.js';
import { writeProjectConfig } from '../lib/project.js';
import type { TeamsResponse, PaginatedResponse, StaticSite, MessageWithDataResponse } from '../types/api.js';

export const linkCommand = new Command('link')
  .description('Link current directory to a DanubeData static site')
  .action(async () => {
    const api = await ApiClient.create();

    // 1. Fetch teams
    const teamsRes = await api.get<TeamsResponse>('/api/v1/user/teams');
    const teams = teamsRes.data;

    let teamId: number;
    if (teams.length === 1) {
      teamId = teams[0]!.id;
      console.log(`Team: ${chalk.bold(teams[0]!.name)}`);
    } else {
      teamId = await select({
        message: 'Select a team:',
        choices: teams.map(t => ({ name: t.name, value: t.id })),
      });
    }

    // 2. Fetch existing sites
    const sitesRes = await api.get<PaginatedResponse<StaticSite>>(
      `/api/v1/teams/${teamId}/static-sites`,
    );

    const CREATE_NEW = -1;
    const choices = [
      ...sitesRes.data.map(s => ({ name: `${s.name} (${s.default_domain})`, value: s.id })),
      { name: chalk.cyan('+ Create new site'), value: CREATE_NEW },
    ];

    const siteChoice = await select({
      message: 'Select a site to link:',
      choices,
    });

    let site: StaticSite;

    if (siteChoice === CREATE_NEW) {
      const name = await input({
        message: 'Site name:',
        validate: (v: string) => v.trim().length > 0 || 'Name is required',
      });

      const res = await api.post<MessageWithDataResponse<StaticSite>>(
        `/api/v1/teams/${teamId}/static-sites`,
        { name: name.trim() },
      );
      site = res.data;
      console.log(chalk.green(`Created site: ${site.name}`));
    } else {
      site = sitesRes.data.find(s => s.id === siteChoice)!;
    }

    // 3. Write project config
    await writeProjectConfig({
      siteId: site.id,
      teamId: teamId,
      siteName: site.name,
    });

    console.log(chalk.green(`\nLinked to ${chalk.bold(site.name)} (${site.default_domain})`));
    console.log(`Config saved to ${chalk.dim('.danube/project.json')}`);
  });
