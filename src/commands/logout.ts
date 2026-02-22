import { Command } from 'commander';
import chalk from 'chalk';
import { deleteConfig } from '../lib/config.js';

export const logoutCommand = new Command('logout')
  .description('Remove stored authentication')
  .action(async () => {
    await deleteConfig();
    console.log(chalk.green('Logged out.'));
  });
