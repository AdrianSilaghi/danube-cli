import { Command } from 'commander';
import chalk from 'chalk';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { whoamiCommand } from './commands/whoami.js';
import { linkCommand } from './commands/link.js';
import { deployCommand } from './commands/deploy.js';
import { deploymentsCommand } from './commands/deployments.js';
import { domainsCommand } from './commands/domains.js';
import { lsCommand as serverlessLsCommand } from './commands/serverless/ls.js';
import { createCommand as serverlessCreateCommand } from './commands/serverless/create.js';
import { deployCommand as serverlessDeployCommand } from './commands/serverless/deploy.js';
import { showCommand as serverlessShowCommand } from './commands/serverless/show.js';
import { updateCommand as serverlessUpdateCommand } from './commands/serverless/update.js';
import { rmCommand as serverlessRmCommand } from './commands/serverless/rm.js';
import { deploymentsCommand as serverlessDeploymentsCommand } from './commands/serverless/deployments.js';
import { usageCommand as serverlessUsageCommand } from './commands/serverless/usage.js';
import { NotAuthenticatedError, NotLinkedError, ApiError } from './lib/errors.js';
import { getCurrentVersion, checkForUpdate, printUpdateNotification } from './lib/version.js';

const program = new Command()
  .name('danube')
  .description('DanubeData CLI')
  .version(getCurrentVersion());

program.addCommand(loginCommand);
program.addCommand(logoutCommand);
program.addCommand(whoamiCommand);

const pagesCommand = new Command('pages')
  .description('Manage static sites');
pagesCommand.addCommand(linkCommand);
pagesCommand.addCommand(deployCommand);
pagesCommand.addCommand(deploymentsCommand);
pagesCommand.addCommand(domainsCommand);
program.addCommand(pagesCommand);

const serverlessCommand = new Command('serverless')
  .description('Manage serverless containers');
serverlessCommand.addCommand(serverlessLsCommand);
serverlessCommand.addCommand(serverlessCreateCommand);
serverlessCommand.addCommand(serverlessDeployCommand);
serverlessCommand.addCommand(serverlessShowCommand);
serverlessCommand.addCommand(serverlessUpdateCommand);
serverlessCommand.addCommand(serverlessRmCommand);
serverlessCommand.addCommand(serverlessDeploymentsCommand);
serverlessCommand.addCommand(serverlessUsageCommand);
program.addCommand(serverlessCommand);

// Graceful SIGINT fallback — clean exit when Ctrl+C is pressed outside polling loops
process.on('SIGINT', () => {
  console.log('');
  process.exit(130);
});

// Shared error handler
function handleError(err: unknown): never {
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
}

process.on('unhandledRejection', handleError);

program.parseAsync()
  .then(async () => {
    const result = await checkForUpdate();
    if (result?.updateAvailable) {
      printUpdateNotification(result.current, result.latest);
    }
  })
  .catch(handleError);
