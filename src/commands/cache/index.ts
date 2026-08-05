import { Command } from 'commander';
import { lsCommand, createCommand, getCommand, updateCommand, rmCommand } from './instances.js';
import { startCommand, stopCommand, connectionInfoCommand, metricsCommand, dnsCommand } from './actions.js';
import { createDiagnoseCommand, createLogsCommand, createEventsCommand } from '../../lib/diagnostics/commands.js';
import { snapshotsCommand } from './snapshots.js';


const diagnosticsTarget = { noun: 'cache instance', kind: 'cache', listPath: '/api/v1/cache', resourcePath: (id: string) => `/api/v1/cache/${id}` };
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
  .addCommand(snapshotsCommand)
  .addCommand(createDiagnoseCommand(diagnosticsTarget))
  .addCommand(createLogsCommand(diagnosticsTarget))
  .addCommand(createEventsCommand(diagnosticsTarget));
