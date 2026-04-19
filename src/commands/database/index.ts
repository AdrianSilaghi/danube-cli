import { Command } from 'commander';
import { lsCommand, createCommand, getCommand, updateCommand, rmCommand } from './instances.js';
import { startCommand, stopCommand, credentialsCommand, dnsCommand } from './actions.js';

export const databaseCommand = new Command('database')
  .description('Manage database instances (MySQL / PostgreSQL / MariaDB)')
  .addCommand(lsCommand)
  .addCommand(createCommand)
  .addCommand(getCommand)
  .addCommand(updateCommand)
  .addCommand(rmCommand)
  .addCommand(startCommand)
  .addCommand(stopCommand)
  .addCommand(credentialsCommand)
  .addCommand(dnsCommand);
