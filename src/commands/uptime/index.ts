import { Command } from 'commander';
import { lsCommand, createCommand, getCommand, updateCommand, rmCommand } from './checks.js';
import { pauseCommand, resumeCommand, incidentsCommand, diagnoseCommand } from './actions.js';

export const uptimeCommand = new Command('uptime')
  .alias('uptime-checks')
  .description('Manage uptime checks')
  .addCommand(lsCommand)
  .addCommand(createCommand)
  .addCommand(getCommand)
  .addCommand(updateCommand)
  .addCommand(rmCommand)
  .addCommand(pauseCommand)
  .addCommand(resumeCommand)
  .addCommand(incidentsCommand)
  .addCommand(diagnoseCommand);
