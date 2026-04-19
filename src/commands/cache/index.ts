import { Command } from 'commander';
import { lsCommand, createCommand, getCommand, updateCommand, rmCommand } from './instances.js';
import { startCommand, stopCommand, connectionInfoCommand, metricsCommand, dnsCommand } from './actions.js';
import { snapshotsCommand } from './snapshots.js';

export const cacheCommand = new Command('cache')
  .description('Manage cache instances (Redis / Valkey / Dragonfly)')
  .addCommand(lsCommand)
  .addCommand(createCommand)
  .addCommand(getCommand)
  .addCommand(updateCommand)
  .addCommand(rmCommand)
  .addCommand(startCommand)
  .addCommand(stopCommand)
  .addCommand(connectionInfoCommand)
  .addCommand(metricsCommand)
  .addCommand(dnsCommand)
  .addCommand(snapshotsCommand);
