import { Command } from 'commander';
import { bucketsCommand } from './buckets.js';
import { createDiagnoseCommand } from '../../lib/diagnostics/commands.js';
import { keysCommand } from './keys.js';


const diagnosticsTarget = { noun: 'bucket', kind: 'bucket', listPath: '/api/v1/storage/buckets', resourcePath: (id: string) => `/api/v1/storage/buckets/${id}` };
// Buckets have no logs or events surface — `capabilities` says so, and
// diagnose is where quota and provisioning findings land.
export const storageCommand = new Command('storage')
  .description('Manage object storage')
  .addCommand(bucketsCommand)
  .addCommand(keysCommand)
  .addCommand(createDiagnoseCommand(diagnosticsTarget));
