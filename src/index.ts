import { Command } from 'commander';
import chalk from 'chalk';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { whoamiCommand } from './commands/whoami.js';
import { linkCommand } from './commands/link.js';
import { deployCommand } from './commands/deploy.js';
import { deploymentsCommand } from './commands/deployments.js';
import { domainsCommand } from './commands/domains.js';
import { NotAuthenticatedError, NotLinkedError, ApiError } from './lib/errors.js';

const program = new Command()
  .name('danube')
  .description('Deploy static sites to DanubeData')
  .version('0.1.0');

program.addCommand(loginCommand);
program.addCommand(logoutCommand);
program.addCommand(whoamiCommand);
program.addCommand(linkCommand);
program.addCommand(deployCommand);
program.addCommand(deploymentsCommand);
program.addCommand(domainsCommand);

// Global error handler
program.hook('postAction', () => {});
process.on('unhandledRejection', (err) => {
  if (err instanceof NotAuthenticatedError) {
    console.error(chalk.red(err.message));
    process.exit(1);
  }
  if (err instanceof NotLinkedError) {
    console.error(chalk.red(err.message));
    process.exit(1);
  }
  if (err instanceof ApiError) {
    console.error(chalk.red(`API Error (${err.statusCode}): ${err.message}`));
    if (err.errors) {
      for (const [field, messages] of Object.entries(err.errors)) {
        for (const msg of messages) {
          console.error(chalk.red(`  ${field}: ${msg}`));
        }
      }
    }
    process.exit(1);
  }
  if (err instanceof Error) {
    console.error(chalk.red(err.message));
    process.exit(1);
  }
  console.error(chalk.red('An unexpected error occurred.'));
  process.exit(1);
});

program.parseAsync().catch((err) => {
  if (err instanceof NotAuthenticatedError || err instanceof NotLinkedError) {
    console.error(chalk.red(err.message));
    process.exit(1);
  }
  if (err instanceof ApiError) {
    console.error(chalk.red(`API Error (${err.statusCode}): ${err.message}`));
    if (err.errors) {
      for (const [field, messages] of Object.entries(err.errors)) {
        for (const msg of messages) {
          console.error(chalk.red(`  ${field}: ${msg}`));
        }
      }
    }
    process.exit(1);
  }
  console.error(chalk.red(err instanceof Error ? err.message : 'An unexpected error occurred.'));
  process.exit(1);
});
