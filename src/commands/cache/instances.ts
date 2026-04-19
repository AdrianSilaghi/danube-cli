import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { input, select, confirm } from '@inquirer/prompts';
import { ApiClient } from '../../lib/api-client.js';
import { formatTable, statusColor, formatDate } from '../../lib/output.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import type { CacheInstance, CacheProvider, PaginatedResponse } from '../../types/api.js';

const CACHE_PLANS: Array<{ name: string; value: string }> = [
  { name: 'micro  — 0.25 GB RAM, 1 vCPU  — starter', value: 'micro' },
  { name: 'small  — 1 GB RAM,   1 vCPU  — balanced', value: 'small' },
  { name: 'medium — 3 GB RAM,   1 vCPU  — production', value: 'medium' },
  { name: 'large  — 6 GB RAM,   1 vCPU  — performance', value: 'large' },
];

const CACHE_DATACENTERS = ['fsn1', 'nbg1', 'hel1', 'ash'];
const CACHE_PROVIDERS: CacheProvider[] = ['redis', 'valkey', 'dragonfly'];

export const lsCommand = new Command('ls')
  .description('List all cache instances')
  .action(async () => {
    const api = await ApiClient.create();
    const res = await api.get<PaginatedResponse<CacheInstance>>('/api/v1/cache');

    if (isJsonMode()) {
      jsonOutput(res.data);
      return;
    }

    if (res.data.length === 0) {
      console.log('No cache instances found.');
      return;
    }

    const rows = res.data.map(c => [
      c.id,
      c.name,
      c.provider?.type ?? '-',
      statusColor(c.status),
      c.resource_profile,
      `${(c.memory_size_mb / 1024).toFixed(2)} GB`,
      c.endpoint ?? '-',
      `\u20AC${c.monthly_cost_dollars}/mo`,
      formatDate(c.created_at),
    ]);

    console.log(formatTable(
      ['ID', 'NAME', 'PROVIDER', 'STATUS', 'PROFILE', 'MEMORY', 'ENDPOINT', 'COST/MO', 'CREATED'],
      rows,
    ));
  });

export const createCommand = new Command('create')
  .description('Create a new cache instance')
  .option('--name <name>', 'Instance name (lowercase, alphanumeric, hyphens)')
  .option('--provider <provider>', 'Provider: redis, valkey, or dragonfly')
  .option('--version <version>', 'Specific provider version (optional)')
  .option('--datacenter <dc>', 'Datacenter region', 'fsn1')
  .option('--profile <profile>', 'Resource profile: micro, small, medium, large')
  .action(async (opts: {
    name?: string; provider?: string; version?: string; datacenter: string; profile?: string;
  }) => {
    let name = opts.name;
    let provider = opts.provider as CacheProvider | undefined;
    let profile = opts.profile;

    if (!name) {
      name = await input({
        message: 'Instance name:',
        validate: (v: string) => /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(v.trim()) || 'Lowercase letters, numbers, and hyphens only',
      });
    }

    if (!provider) {
      provider = await select<CacheProvider>({
        message: 'Provider:',
        choices: CACHE_PROVIDERS.map(p => ({ name: p, value: p })),
      });
    } else if (!CACHE_PROVIDERS.includes(provider)) {
      console.error(chalk.red(`Invalid provider "${provider}". Valid: ${CACHE_PROVIDERS.join(', ')}`));
      process.exit(1);
    }

    if (!profile) {
      profile = await select({
        message: 'Resource profile:',
        choices: CACHE_PLANS,
      });
    }

    if (!CACHE_DATACENTERS.includes(opts.datacenter)) {
      console.error(chalk.red(`Invalid datacenter "${opts.datacenter}". Valid: ${CACHE_DATACENTERS.join(', ')}`));
      process.exit(1);
    }

    const body: Record<string, unknown> = {
      name: name.trim(),
      provider,
      datacenter: opts.datacenter,
      resource_profile: profile,
    };
    if (opts.version) body.version = opts.version;

    const api = await ApiClient.create();
    const spinner = isJsonMode() ? null : ora('Creating cache instance...').start();
    const res = await api.post<{ message: string; instance: CacheInstance }>('/api/v1/cache', body);

    if (isJsonMode()) {
      jsonOutput(res.instance);
      return;
    }
    spinner!.succeed(`Created cache ${chalk.bold(res.instance.name)} (${res.instance.id})`);
  });

export const getCommand = new Command('get')
  .description('Show cache instance details')
  .argument('<id>', 'Cache instance ID')
  .action(async (id: string) => {
    const api = await ApiClient.create();
    const res = await api.get<{ instance: CacheInstance; connection_info: string | null; monthly_cost: number | string }>(
      `/api/v1/cache/${id}`,
    );

    if (isJsonMode()) {
      jsonOutput({ ...res.instance, connection_info: res.connection_info, monthly_cost: res.monthly_cost });
      return;
    }

    const c = res.instance;
    const lines = [
      ['ID', c.id],
      ['Name', c.name],
      ['Status', statusColor(c.status)],
      ['Provider', c.provider?.type ?? '-'],
      ['Version', c.version ?? '-'],
      ['Profile', c.resource_profile],
      ['CPU', `${c.cpu_cores} cores`],
      ['Memory', `${(c.memory_size_mb / 1024).toFixed(2)} GB (${c.memory_size_mb} MB)`],
      ['Endpoint', c.endpoint ?? '-'],
      ['Port', c.port !== null ? String(c.port) : '-'],
      ['Connection', res.connection_info ?? '-'],
      ['Cost', `\u20AC${res.monthly_cost ?? c.monthly_cost_dollars}/mo`],
      ['Created', formatDate(c.created_at)],
      ['Deployed', c.deployed_at ? formatDate(c.deployed_at) : '-'],
    ];

    const maxLabel = Math.max(...lines.map(([l]) => l!.length));
    for (const [label, value] of lines) {
      console.log(`${chalk.dim(label!.padEnd(maxLabel))}  ${value}`);
    }
  });

export const updateCommand = new Command('update')
  .description('Update a cache instance')
  .argument('<id>', 'Cache instance ID')
  .option('--name <name>', 'New name')
  .option('--profile <profile>', 'Resource profile: micro, small, medium, large')
  .option('--snapshots', 'Enable automated snapshots')
  .option('--no-snapshots', 'Disable automated snapshots')
  .action(async (id: string, opts: { name?: string; profile?: string; snapshots?: boolean }) => {
    const body: Record<string, unknown> = {};
    if (opts.name !== undefined) body.name = opts.name;
    if (opts.profile !== undefined) body.resource_profile = opts.profile;
    if (opts.snapshots !== undefined) body.automated_snapshots_enabled = opts.snapshots;

    if (Object.keys(body).length === 0) {
      console.error(chalk.red('At least one option is required.'));
      process.exit(1);
    }

    const api = await ApiClient.create();
    const spinner = isJsonMode() ? null : ora('Updating cache instance...').start();
    const res = await api.put<{ message: string; instance: CacheInstance }>(`/api/v1/cache/${id}`, body);

    if (isJsonMode()) {
      jsonOutput(res.instance);
      return;
    }
    spinner!.succeed(`Updated cache ${chalk.bold(res.instance.name)}`);
  });

export const rmCommand = new Command('rm')
  .description('Delete a cache instance')
  .argument('<id>', 'Cache instance ID')
  .option('--force', 'Skip confirmation')
  .action(async (id: string, opts: { force?: boolean }) => {
    if (!opts.force && !isJsonMode()) {
      const confirmed = await confirm({
        message: `Are you sure you want to delete cache ${id}? This cannot be undone.`,
        default: false,
      });
      if (!confirmed) {
        console.log('Cancelled.');
        return;
      }
    }

    const api = await ApiClient.create();
    const spinner = isJsonMode() ? null : ora('Deleting cache instance...').start();
    await api.delete<{ message: string; status: string }>(`/api/v1/cache/${id}`);

    if (isJsonMode()) {
      jsonOutput({ status: 'destroying', id });
      return;
    }
    spinner!.succeed('Cache instance deletion initiated');
  });
