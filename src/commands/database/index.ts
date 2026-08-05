import { Command } from 'commander';
import { lsCommand, createCommand, getCommand, updateCommand, rmCommand } from './instances.js';
import { startCommand, stopCommand, credentialsCommand, metricsCommand, dnsCommand } from './actions.js';
import { replicasCommand } from './replicas.js';
import { createDiagnoseCommand, createLogsCommand, createEventsCommand } from '../../lib/diagnostics/commands.js';
import { snapshotsCommand } from './snapshots.js';


const diagnosticsTarget = { noun: 'database instance', kind: 'database', listPath: '/api/v1/database', resourcePath: (id: string) => `/api/v1/database/${id}` };
export const databaseCommand = new Command('database')
  .alias('db')
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
  .addCommand(snapshotsCommand)
  .addCommand(createDiagnoseCommand(diagnosticsTarget))
  .addCommand(createLogsCommand(diagnosticsTarget))
  .addCommand(createEventsCommand(diagnosticsTarget));
