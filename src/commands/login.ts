import { Command } from 'commander';
import { password } from '@inquirer/prompts';
import chalk from 'chalk';
import { writeConfig, getApiBase } from '../lib/config.js';
import { ApiError } from '../lib/errors.js';
import type { User } from '../types/api.js';

export const loginCommand = new Command('login')
  .description('Authenticate with DanubeData')
  .option('--token <token>', 'API token (prefer DANUBE_TOKEN env var in CI to avoid shell history exposure)')
  .action(async (opts: { token?: string }) => {
    let token = opts.token;

    if (!token) {
      console.log(chalk.bold('Log in to DanubeData\n'));
      console.log(`Create an API token at: ${chalk.cyan(`${getApiBase()}/user/api-tokens`)}\n`);

      token = await password({
        message: 'Paste your API token:',
        mask: '*',
      });
    }

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
      await writeConfig(config);

      console.log(chalk.green(`\nAuthenticated as ${chalk.bold(user.name)} (${user.email})`));
    } catch (err) {
      if (err instanceof ApiError) throw err;
      console.error(chalk.red('Failed to connect to DanubeData API.'));
      process.exit(1);
    }
  });
