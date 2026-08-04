import { Command } from 'commander';
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
import { cacheCommand } from './commands/cache/index.js';
import { databaseCommand } from './commands/database/index.js';
import { parameterGroupsCommand } from './commands/parameter-groups.js';
import { projectCommand } from './commands/project.js';
import { lsCommand as serverlessLsCommand } from './commands/serverless/ls.js';
import { createCommand as serverlessCreateCommand } from './commands/serverless/create.js';
import { deployCommand as serverlessDeployCommand } from './commands/serverless/deploy.js';
import { redeployCommand as serverlessRedeployCommand } from './commands/serverless/redeploy.js';
import { showCommand as serverlessShowCommand } from './commands/serverless/show.js';
import { updateCommand as serverlessUpdateCommand } from './commands/serverless/update.js';
import { rmCommand as serverlessRmCommand } from './commands/serverless/rm.js';
import { deploymentsCommand as serverlessDeploymentsCommand } from './commands/serverless/deployments.js';
import { usageCommand as serverlessUsageCommand } from './commands/serverless/usage.js';
import {
  logsCommand as rapidsLogsCommand,
  revisionsCommand as rapidsRevisionsCommand,
  eventsCommand as rapidsEventsCommand,
} from './commands/serverless/diagnostics.js';
import { diagnoseCommand } from './commands/serverless/diagnose.js';
import { registryCommand } from './commands/registry/index.js';
import { handleError } from './lib/handle-error.js';
import { getCurrentVersion, checkForUpdate, printUpdateNotification } from './lib/version.js';
import { setJsonMode, isJsonMode } from './lib/json-mode.js';
import { setProjectOverride, resolveProjectFlag } from './lib/project-context.js';

const program = new Command()
  .name('danube')
  .description('DanubeData CLI')
  .version(getCurrentVersion())
  .option('--json', 'Output results as JSON (for scripting and LLM tool use)')
  // Project context is a REQUEST concern, so it is declared once here and
  // inherited by every subcommand — rather than re-implemented per command,
  // which is how a flag came to be honoured by one and ignored by the next.
  .option('--project <id>', 'Run against this project (team) id, for this invocation only')
  .option('--team <id>', 'Alias for --project (compatibility)');

// Set JSON mode and project context before any command runs.
program.hook('preAction', (thisCommand) => {
  const opts = thisCommand.optsWithGlobals();
  if (opts.json) {
    setJsonMode(true);
  }
  // A global flag scopes THIS invocation and never mutates saved config;
  // persisting it would leak the selection into the next process.
  setProjectOverride(resolveProjectFlag(opts));
});

program.addCommand(loginCommand);
program.addCommand(authCommand);
program.addCommand(logoutCommand);
program.addCommand(whoamiCommand);
program.addCommand(storageCommand);
program.addCommand(vpsCommand);
program.addCommand(cacheCommand);
program.addCommand(databaseCommand);
program.addCommand(parameterGroupsCommand);
program.addCommand(projectCommand);

const pagesCommand = new Command('pages')
  .description('Manage static sites');
pagesCommand.addCommand(linkCommand);
pagesCommand.addCommand(deployCommand);
pagesCommand.addCommand(deploymentsCommand);
pagesCommand.addCommand(domainsCommand);
program.addCommand(pagesCommand);

const serverlessCommand = new Command('rapids')
  .description('Manage rapids containers');
serverlessCommand.addCommand(serverlessLsCommand);
serverlessCommand.addCommand(serverlessCreateCommand);
serverlessCommand.addCommand(serverlessDeployCommand);
serverlessCommand.addCommand(serverlessRedeployCommand);
serverlessCommand.addCommand(serverlessShowCommand);
serverlessCommand.addCommand(serverlessUpdateCommand);
serverlessCommand.addCommand(serverlessRmCommand);
serverlessCommand.addCommand(serverlessDeploymentsCommand);
serverlessCommand.addCommand(serverlessUsageCommand);
serverlessCommand.addCommand(rapidsLogsCommand);
serverlessCommand.addCommand(rapidsRevisionsCommand);
serverlessCommand.addCommand(rapidsEventsCommand);
serverlessCommand.addCommand(diagnoseCommand);
program.addCommand(serverlessCommand);
program.addCommand(registryCommand);

// Graceful SIGINT fallback — clean exit when Ctrl+C is pressed outside polling loops
process.on('SIGINT', () => {
  if (!isJsonMode()) console.log('');
  process.exit(130);
});

// Global error handler
program.hook('postAction', () => {});
process.on('unhandledRejection', (err) => handleError(err));

program.parseAsync()
  .then(async () => {
    if (!isJsonMode() && process.stderr.isTTY) {
      const result = await checkForUpdate();
      if (result?.updateAvailable) {
        printUpdateNotification(result.current, result.latest);
      }
    }
  })
  .catch((err) => handleError(err));
