import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { input, select } from '@inquirer/prompts';
import { ApiClient } from '../../lib/api-client.js';
import { fetchAllPages } from '../../lib/paginate.js';
import { resolveResource } from '../../lib/resolve.js';
import { formatTable, statusColor, formatDate, printDetails } from '../../lib/output.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import { promptOr, confirmDestruction } from '../../lib/interactive.js';
import type { CacheInstance, CacheProvider, CachePlanInfo, PlansResponse } from '../../types/api.js';

const CACHE_DATACENTERS = ['fsn1', 'nbg1', 'hel1', 'ash'];
const CACHE_PROVIDERS: CacheProvider[] = ['redis', 'valkey', 'dragonfly'];

export const lsCommand = new Command('ls')
  .description('List all cache instances')
  .action(async () => {
    const api = await ApiClient.create();
    const { items, total, truncated } = await fetchAllPages<CacheInstance>(api, '/api/v1/cache');

    if (isJsonMode()) {
      jsonOutput(items);
      return;
    }

    if (items.length === 0) {
      console.log('No cache instances found.');
      return;
    }

    const rows = items.map(c => [
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

    if (truncated) {
      console.log(chalk.dim(`Showing ${items.length} of ${total}. Refine with the web console for the full list.`));
    }
  });

export const createCommand = new Command('create')
  .description('Create a new cache instance')
  .option('--name <name>', 'Instance name (lowercase, alphanumeric, hyphens)')
  .option('--provider <provider>', 'Provider: redis, valkey, or dragonfly')
  .option('--version <version>', 'Specific provider version (optional)')
  .option('--datacenter <dc>', 'Datacenter region', 'fsn1')
  .option('--profile <profile>', 'Resource profile slug (run interactively to list available plans)')
  .action(async (opts: {
    name?: string; provider?: string; version?: string; datacenter: string; profile?: string;
  }) => {
    // Validate a provider passed via flag before we'd otherwise prompt for it.
    if (opts.provider && !CACHE_PROVIDERS.includes(opts.provider as CacheProvider)) {
      console.error(chalk.red(`Invalid provider "${opts.provider}". Valid: ${CACHE_PROVIDERS.join(', ')}`));
      process.exit(1);
    }

    const api = await ApiClient.create();

    const name = await promptOr('--name', opts.name, () => input({
      message: 'Instance name:',
      validate: (v: string) => /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(v.trim()) || 'Lowercase letters, numbers, and hyphens only',
    }));

    const provider = await promptOr('--provider', opts.provider as CacheProvider | undefined, () => select<CacheProvider>({
      message: 'Provider:',
      choices: CACHE_PROVIDERS.map(p => ({ name: p, value: p })),
    }));

    const profile = await promptOr('--profile', opts.profile, async () => {
      const plansRes = await api.get<PlansResponse<CachePlanInfo>>(`/api/v1/cache/plans?provider=${provider}`);
      if (plansRes.plans.length === 0) {
        throw new Error('No cache plans are currently available from the API. Try again later or contact support.');
      }
      return select({
        message: 'Resource profile:',
        choices: plansRes.plans.map((p) => ({
          name: `${p.display_name} — ${(p.memory_mb / 1024).toFixed(2)} GB RAM, ${p.cpu_cores} vCPU — \u20AC${p.monthly_cost.toFixed(2)}/mo`,
          value: p.slug,
        })),
      });
    });

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
  .argument('<name-or-id>', 'Cache instance name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const instance = await resolveResource<CacheInstance>(api, '/api/v1/cache', 'cache', nameOrId);
    const res = await api.get<{ instance: CacheInstance; connection_info: string | null; monthly_cost: number | string }>(
      `/api/v1/cache/${instance.id}`,
    );

    if (isJsonMode()) {
      jsonOutput({ ...res.instance, connection_info: res.connection_info, monthly_cost: res.monthly_cost });
      return;
    }

    const c = res.instance;
    const lines: Array<[string, string]> = [
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

    printDetails(lines);
  });

export const updateCommand = new Command('update')
  .description('Update a cache instance')
  .argument('<name-or-id>', 'Cache instance name or ID')
  .option('--name <name>', 'New name')
  .option('--profile <profile>', 'Resource profile: micro, small, medium, large')
  .option('--snapshots', 'Enable automated snapshots')
  .option('--no-snapshots', 'Disable automated snapshots')
  .action(async (nameOrId: string, opts: { name?: string; profile?: string; snapshots?: boolean }) => {
    const body: Record<string, unknown> = {};
    if (opts.name !== undefined) body.name = opts.name;
    if (opts.profile !== undefined) body.resource_profile = opts.profile;
    if (opts.snapshots !== undefined) body.automated_snapshots_enabled = opts.snapshots;

    if (Object.keys(body).length === 0) {
      console.error(chalk.red('At least one option is required.'));
      process.exit(1);
    }

    const api = await ApiClient.create();
    const instance = await resolveResource<CacheInstance>(api, '/api/v1/cache', 'cache', nameOrId);
    const spinner = isJsonMode() ? null : ora('Updating cache instance...').start();
    const res = await api.put<{ message: string; instance: CacheInstance }>(`/api/v1/cache/${instance.id}`, body);

    if (isJsonMode()) {
      jsonOutput(res.instance);
      return;
    }
    spinner!.succeed(`Updated cache ${chalk.bold(res.instance.name)}`);
  });

export const rmCommand = new Command('rm')
  .description('Delete a cache instance')
  .argument('<name-or-id>', 'Cache instance name or ID')
  .option('-f, --force', 'Skip confirmation')
  .option('-y, --yes', 'Alias for --force')
  .action(async (nameOrId: string, opts: { force?: boolean; yes?: boolean }) => {
    const api = await ApiClient.create();
    const instance = await resolveResource<CacheInstance>(api, '/api/v1/cache', 'cache', nameOrId);

    const proceed = await confirmDestruction(
      `deletion of cache ${instance.name}`,
      `Are you sure you want to delete cache ${instance.name} (${instance.id})? This cannot be undone.`,
      opts.force || opts.yes,
    );
    if (!proceed) {
      console.log('Cancelled.');
      return;
    }

    const spinner = isJsonMode() ? null : ora('Deleting cache instance...').start();
    await api.delete<{ message: string; status: string }>(`/api/v1/cache/${instance.id}`);

    if (isJsonMode()) {
      jsonOutput({ status: 'destroying', id: instance.id });
      return;
    }
    spinner!.succeed('Cache instance deletion initiated');
  });
