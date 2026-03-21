import { Command } from 'commander';
import { bucketsCommand } from './buckets.js';
import { keysCommand } from './keys.js';

export const storageCommand = new Command('storage')
  .description('Manage object storage')
  .addCommand(bucketsCommand)
  .addCommand(keysCommand);
