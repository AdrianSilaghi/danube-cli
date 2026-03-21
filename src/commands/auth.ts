import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { exec } from 'node:child_process';
import chalk from 'chalk';
import { writeConfig, getApiBase } from '../lib/config.js';
import { ApiError } from '../lib/errors.js';
import { sleep } from '../lib/sleep.js';
import type { User } from '../types/api.js';

const AUTH_TIMEOUT = 120_000; // 2 minutes
const POLL_INTERVAL = 2_000; // 2 seconds

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32' ? 'start' :
    'xdg-open';

  exec(`${cmd} "${url}"`);
}

export const authCommand = new Command('auth')
  .description('Authenticate with DanubeData via browser')
  .action(async () => {
    const apiBase = getApiBase();
    const consoleBase = apiBase.replace('://', '://console.');
    const state = randomUUID();

    const authorizeUrl = `${consoleBase}/cli/authorize?state=${state}`;

    console.log(chalk.bold('Authenticating with DanubeData...\n'));
    console.log(`Opening browser to: ${chalk.cyan(authorizeUrl)}\n`);
    console.log(chalk.dim('Waiting for authorization...'));

    openBrowser(authorizeUrl);

    // Poll for the token
    const startTime = Date.now();
    let token: string | null = null;

    while (Date.now() - startTime < AUTH_TIMEOUT) {
      await sleep(POLL_INTERVAL);

      try {
        const res = await fetch(`${consoleBase}/cli/poll?state=${state}`, {
          headers: { 'Accept': 'application/json' },
        });

        if (res.ok) {
          const data = await res.json() as { token?: string };
          if (data.token) {
            token = data.token;
            break;
          }
        }
      } catch {
        // Network error, keep polling
      }
    }

    if (!token) {
      console.error(chalk.red('Authentication timed out. Please try again.'));
      process.exit(1);
    }

    // Validate the token
    try {
      const res = await fetch(`${apiBase}/api/user`, {
        headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!res.ok) {
        if (res.status === 401) {
          console.error(chalk.red('Received invalid token from server.'));
          process.exit(1);
        }
        throw new ApiError(res.status, `Token validation failed with status ${res.status}`);
      }

      const user = (await res.json()) as User;
      await writeConfig({ token, apiBase });

      console.log(chalk.green(`\nAuthenticated as ${chalk.bold(user.name)} (${user.email})`));
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
        console.error(chalk.red('Failed to connect to DanubeData API.'));
        process.exit(1);
      }
      throw err;
    }
  });
