import { Command } from 'commander';
import chalk from 'chalk';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { whoamiCommand } from './commands/whoami.js';
import { linkCommand } from './commands/link.js';
import { deployCommand } from './commands/deploy.js';
import { deploymentsCommand } from './commands/deployments.js';
import { domainsCommand } from './commands/domains.js';
import { authCommand } from './commands/auth.js';
import { storageCommand } from './commands/storage/index.js';
import { vpsCommand } from './commands/vps/index.js';
import { projectCommand } from './commands/project.js';
import { NotAuthenticatedError, NotLinkedError, ApiError } from './lib/errors.js';
import { getCurrentVersion, checkForUpdate, printUpdateNotification } from './lib/version.js';
import { setJsonMode, isJsonMode, jsonError } from './lib/json-mode.js';

const program = new Command()
  .name('danube')
  .description('DanubeData CLI')
  .version(getCurrentVersion())
  .option('--json', 'Output results as JSON (for scripting and LLM tool use)');

// Set JSON mode before any command runs
program.hook('preAction', (thisCommand) => {
  const opts = thisCommand.optsWithGlobals();
  if (opts.json) {
    setJsonMode(true);
  }
});

program.addCommand(loginCommand);
program.addCommand(authCommand);
program.addCommand(logoutCommand);
program.addCommand(whoamiCommand);
program.addCommand(storageCommand);
program.addCommand(vpsCommand);
program.addCommand(projectCommand);

const pagesCommand = new Command('pages')
  .description('Manage static sites');
pagesCommand.addCommand(linkCommand);
pagesCommand.addCommand(deployCommand);
pagesCommand.addCommand(deploymentsCommand);
pagesCommand.addCommand(domainsCommand);
program.addCommand(pagesCommand);

function handleError(err: unknown): never {
  if (isJsonMode()) {
    if (err instanceof NotAuthenticatedError) {
      jsonError({ code: 'not_authenticated', message: err.message });
    } else if (err instanceof NotLinkedError) {
      jsonError({ code: 'not_linked', message: err.message });
    } else if (err instanceof ApiError) {
      jsonError({ code: 'api_error', message: err.message, ...(err.errors && { errors: err.errors }) });
    } else if (err instanceof Error) {
      jsonError({ code: 'error', message: err.message });
    } else {
      jsonError({ code: 'error', message: 'An unexpected error occurred.' });
    }
    process.exit(1);
  }

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
  if (err instanceof Error) {
    console.error(chalk.red(err.message));
    process.exit(1);
  }
  console.error(chalk.red('An unexpected error occurred.'));
  process.exit(1);
}

// Global error handler
program.hook('postAction', () => {});
process.on('unhandledRejection', (err) => handleError(err));

program.parseAsync()
  .then(async () => {
    if (!isJsonMode()) {
      const result = await checkForUpdate();
      if (result?.updateAvailable) {
        printUpdateNotification(result.current, result.latest);
      }
    }
  })
  .catch((err) => handleError(err));
