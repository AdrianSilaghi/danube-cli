import { Command } from 'commander';
import { lsCommand, createCommand, getCommand, updateCommand, deleteCommand } from './instances.js';
import { startCommand, stopCommand, rebootCommand, reinstallCommand, statusCommand, metricsCommand, passwordCommand } from './actions.js';
import { createDiagnoseCommand, createEventsCommand } from '../../lib/diagnostics/commands.js';
import { imagesCommand } from './images.js';


const diagnosticsTarget = { noun: 'VPS instance', kind: 'vps', listPath: '/api/v1/vps', resourcePath: (id: string) => `/api/v1/vps/${id}` };
// No `logs`: guest operating system output is the customer's, and the
// platform does not read inside the VM. `capabilities.logs` reports false.
export const vpsCommand = new Command('vps')
  .description('Manage VPS instances')
  .addCommand(lsCommand)
  .addCommand(createCommand)
  .addCommand(getCommand)
  .addCommand(updateCommand)
  .addCommand(deleteCommand)
  .addCommand(startCommand)
  .addCommand(stopCommand)
  .addCommand(rebootCommand)
  .addCommand(reinstallCommand)
  .addCommand(statusCommand)
  .addCommand(metricsCommand)
  .addCommand(passwordCommand)
  .addCommand(imagesCommand)
  .addCommand(createDiagnoseCommand(diagnosticsTarget))
  .addCommand(createEventsCommand(diagnosticsTarget));
