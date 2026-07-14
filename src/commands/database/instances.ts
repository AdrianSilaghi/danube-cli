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
import type { DatabaseInstance, DatabaseProvider, DatabasePlanInfo, PlansResponse } from '../../types/api.js';

const DATABASE_DATACENTERS = ['fsn1', 'nbg1', 'hel1'];
const DATABASE_PROVIDERS: DatabaseProvider[] = ['mysql', 'postgresql', 'mariadb'];

export const lsCommand = new Command('ls')
  .description('List all database instances')
  .action(async () => {
    const api = await ApiClient.create();
    const { items, total, truncated } = await fetchAllPages<DatabaseInstance>(api, '/api/v1/database');

    if (isJsonMode()) {
      jsonOutput(items);
      return;
    }

    if (items.length === 0) {
      console.log('No database instances found.');
      return;
    }

    const rows = items.map(d => [
      d.id,
      d.name,
      d.provider?.type ?? '-',
      statusColor(d.status),
      d.resource_profile,
      `${(d.memory_size_mb / 1024).toFixed(2)} GB`,
      `${d.storage_size_gb} GB`,
      d.endpoint ?? '-',
      `\u20AC${d.monthly_cost_dollars}/mo`,
      formatDate(d.created_at),
    ]);

    console.log(formatTable(
      ['ID', 'NAME', 'ENGINE', 'STATUS', 'PROFILE', 'MEMORY', 'STORAGE', 'ENDPOINT', 'COST/MO', 'CREATED'],
      rows,
    ));

    if (truncated) {
      console.log(chalk.dim(`Showing ${items.length} of ${total}. Refine with the web console for the full list.`));
    }
  });

export const createCommand = new Command('create')
  .description('Create a new database instance')
  .option('--name <name>', 'Instance name (lowercase, alphanumeric, hyphens)')
  .option('--provider <provider>', 'Provider: mysql, postgresql, or mariadb')
  .option('--version <version>', 'Specific provider version (optional)')
  .option('--database-name <name>', 'Initial database name (optional)')
  .option('--datacenter <dc>', 'Datacenter region', 'fsn1')
  .option('--profile <profile>', 'Resource profile slug (run interactively to list available plans)')
  .action(async (opts: {
    name?: string; provider?: string; version?: string; databaseName?: string;
    datacenter: string; profile?: string;
  }) => {
    // Validate a provider passed via flag before we'd otherwise prompt for it.
    if (opts.provider && !DATABASE_PROVIDERS.includes(opts.provider as DatabaseProvider)) {
      console.error(chalk.red(`Invalid provider "${opts.provider}". Valid: ${DATABASE_PROVIDERS.join(', ')}`));
      process.exit(1);
    }

    const api = await ApiClient.create();

    const name = await promptOr('--name', opts.name, () => input({
      message: 'Instance name:',
      validate: (v: string) => /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(v.trim()) || 'Lowercase letters, numbers, and hyphens only',
    }));

    const provider = await promptOr('--provider', opts.provider as DatabaseProvider | undefined, () => select<DatabaseProvider>({
      message: 'Engine:',
      choices: DATABASE_PROVIDERS.map(p => ({ name: p, value: p })),
    }));

    const profile = await promptOr('--profile', opts.profile, async () => {
      const plansRes = await api.get<PlansResponse<DatabasePlanInfo>>('/api/v1/database/plans');
      if (plansRes.plans.length === 0) {
        throw new Error('No database plans are currently available from the API. Try again later or contact support.');
      }
      return select({
        message: 'Resource profile:',
        choices: plansRes.plans.map((p) => ({
          name: `${p.display_name} — ${(p.memory_mb / 1024).toFixed(2)} GB RAM, ${p.cpu_cores} vCPU — \u20AC${p.monthly_cost.toFixed(2)}/mo`,
          value: p.slug,
        })),
      });
    });

    if (!DATABASE_DATACENTERS.includes(opts.datacenter)) {
      console.error(chalk.red(`Invalid datacenter "${opts.datacenter}". Valid: ${DATABASE_DATACENTERS.join(', ')}`));
      process.exit(1);
    }

    const body: Record<string, unknown> = {
      name: name.trim(),
      provider,
      datacenter: opts.datacenter,
      resource_profile: profile,
    };
    if (opts.version) body.version = opts.version;
    if (opts.databaseName) body.database_name = opts.databaseName;

    const spinner = isJsonMode() ? null : ora('Creating database instance...').start();
    const res = await api.post<{ message: string; instance: DatabaseInstance }>('/api/v1/database', body);

    if (isJsonMode()) {
      jsonOutput(res.instance);
      return;
    }
    spinner!.succeed(`Created database ${chalk.bold(res.instance.name)} (${res.instance.id})`);
  });

export const getCommand = new Command('get')
  .description('Show database instance details')
  .argument('<name-or-id>', 'Database instance name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const instance = await resolveResource<DatabaseInstance>(api, '/api/v1/database', 'database', nameOrId);
    const res = await api.get<{ instance: DatabaseInstance; connection_info: string | null; monthly_cost: number | string }>(
      `/api/v1/database/${instance.id}`,
    );

    if (isJsonMode()) {
      jsonOutput({ ...res.instance, connection_info: res.connection_info, monthly_cost: res.monthly_cost });
      return;
    }

    const d = res.instance;
    const lines: Array<[string, string]> = [
      ['ID', d.id],
      ['Name', d.name],
      ['Status', statusColor(d.status)],
      ['Engine', d.provider?.type ?? '-'],
      ['Version', d.version ?? '-'],
      ['Profile', d.resource_profile],
      ['CPU', `${d.cpu_cores} cores`],
      ['Memory', `${(d.memory_size_mb / 1024).toFixed(2)} GB (${d.memory_size_mb} MB)`],
      ['Storage', `${d.storage_size_gb} GB`],
      ['Datacenter', d.datacenter ?? '-'],
      ['Endpoint', d.endpoint ?? '-'],
      ['Port', d.port !== null ? String(d.port) : '-'],
      ['Username', d.username ?? '-'],
      ['Connection', res.connection_info ?? '-'],
      ['Cost', `\u20AC${res.monthly_cost ?? d.monthly_cost_dollars}/mo`],
      ['Created', formatDate(d.created_at)],
      ['Deployed', d.deployed_at ? formatDate(d.deployed_at) : '-'],
    ];

    printDetails(lines);
  });

export const updateCommand = new Command('update')
  .description('Update a database instance')
  .argument('<name-or-id>', 'Database instance name or ID')
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
    const instance = await resolveResource<DatabaseInstance>(api, '/api/v1/database', 'database', nameOrId);
    const spinner = isJsonMode() ? null : ora('Updating database instance...').start();
    const res = await api.put<{ message: string; instance: DatabaseInstance }>(`/api/v1/database/${instance.id}`, body);

    if (isJsonMode()) {
      jsonOutput(res.instance);
      return;
    }
    spinner!.succeed(`Updated database ${chalk.bold(res.instance.name)}`);
  });

export const rmCommand = new Command('rm')
  .alias('delete')
  .description('Delete a database instance')
  .argument('<name-or-id>', 'Database instance name or ID')
  .option('-f, --force', 'Skip confirmation')
  .option('-y, --yes', 'Alias for --force')
  .action(async (nameOrId: string, opts: { force?: boolean; yes?: boolean }) => {
    const api = await ApiClient.create();
    const instance = await resolveResource<DatabaseInstance>(api, '/api/v1/database', 'database', nameOrId);

    const proceed = await confirmDestruction(
      `deletion of database ${instance.name}`,
      `Are you sure you want to delete database ${instance.name} (${instance.id})? This cannot be undone.`,
      opts.force || opts.yes,
    );
    if (!proceed) {
      console.log('Cancelled.');
      return;
    }

    const spinner = isJsonMode() ? null : ora('Deleting database instance...').start();
    await api.delete<{ message: string; status: string }>(`/api/v1/database/${instance.id}`);

    if (isJsonMode()) {
      jsonOutput({ status: 'destroying', id: instance.id });
      return;
    }
    spinner!.succeed('Database instance deletion initiated');
  });
