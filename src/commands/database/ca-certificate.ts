import { writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { ApiClient } from '../../lib/api-client.js';
import { resolveResource } from '../../lib/resolve.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import type { DatabaseInstance } from '../../types/api.js';

interface CaCertificate {
  ca_certificate: string;
  expires_at: string;
  fingerprint_sha256: string;
}

export const caCertificateCommand = new Command('ca-certificate')
  .description('Download the public CA certificate for a PostgreSQL database')
  .argument('<name-or-id>', 'Database instance name or ID')
  .option('--output <path>', 'Save PEM to a new file (refuses to overwrite an existing file)')
  .action(async (nameOrId: string, opts: { output?: string }) => {
    const api = await ApiClient.create();
    const instance = await resolveResource<DatabaseInstance>(api, '/api/v1/database', 'database', nameOrId);
    const res = await api.get<{ success: true; data: CaCertificate }>(`/api/v1/database/${instance.id}/ca-certificate`);

    if (opts.output) {
      await writeFile(opts.output, res.data.ca_certificate, { flag: 'wx', mode: 0o600 });
    }

    if (isJsonMode()) {
      jsonOutput(res.data);
    } else if (opts.output) {
      console.log(`CA certificate saved to ${opts.output}`);
    } else {
      process.stdout.write(res.data.ca_certificate);
    }
  });
