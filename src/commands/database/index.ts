import { Command } from 'commander';
import { lsCommand, createCommand, getCommand, updateCommand, rmCommand } from './instances.js';
import { startCommand, stopCommand, credentialsCommand, metricsCommand, dnsCommand } from './actions.js';
import { replicasCommand } from './replicas.js';
import { snapshotsCommand } from './snapshots.js';

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
  .addCommand(metricsCommand)
  .addCommand(dnsCommand)
  .addCommand(replicasCommand)
  .addCommand(snapshotsCommand);
