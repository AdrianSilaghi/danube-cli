import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { formatTable } from '../../lib/output.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import type { VpsImageGroup } from '../../types/api.js';

export const imagesCommand = new Command('images')
  .description('List available OS images')
  .action(async () => {
    const api = await ApiClient.create();
    const res = await api.get<{ groups: VpsImageGroup[] }>('/api/v1/vps/images/grouped');

    if (isJsonMode()) {
      jsonOutput(res.groups);
      return;
    }

    for (const group of res.groups) {
      console.log(chalk.bold(`\n${group.name}`));

      const rows = group.images.map(img => [
        img.id,
        img.label,
        img.version,
        img.default_user,
      ]);

      console.log(formatTable(['ID', 'LABEL', 'VERSION', 'USER'], rows));
    }
  });
