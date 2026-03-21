import { Command } from 'commander';
import { lsCommand, createCommand, getCommand, updateCommand, deleteCommand } from './instances.js';
import { startCommand, stopCommand, rebootCommand, reinstallCommand, statusCommand, metricsCommand, passwordCommand } from './actions.js';
import { imagesCommand } from './images.js';

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
  .addCommand(imagesCommand);
