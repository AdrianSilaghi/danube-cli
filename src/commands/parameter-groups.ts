import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { confirm } from '@inquirer/prompts';
import fs from 'node:fs';
import { ApiClient } from '../lib/api-client.js';
import { fetchAllPages } from '../lib/paginate.js';
import { formatTable, formatDate } from '../lib/output.js';
import { isJsonMode, jsonOutput } from '../lib/json-mode.js';
import type { ParameterGroup, ParameterGroupType } from '../types/api.js';

const VALID_TYPES: ParameterGroupType[] = ['cache', 'database', 'queue'];

function parseParametersFlag(value: string): Record<string, string | number | boolean | null> {
  const trimmed = value.trim();
  let raw: string;
  if (trimmed.startsWith('@')) {
    raw = fs.readFileSync(trimmed.slice(1), 'utf8');
  } else {
    raw = trimmed;
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
      throw new Error('parameters must be a JSON object');
    }
    return parsed;
  } catch (e) {
    throw new Error(`Invalid JSON for --parameters: ${(e as Error).message}`);
  }
}

function parseLockedFlag(value: string): string[] {
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

const lsCommand = new Command('ls')
  .description('List parameter groups (includes system groups)')
  .option('--type <type>', 'Filter by type: cache | database | queue')
  .option('--provider <provider>', 'Filter by provider_type (e.g. redis, mysql)')
  .action(async (opts: { type?: string; provider?: string }) => {
    if (opts.type && !VALID_TYPES.includes(opts.type as ParameterGroupType)) {
      console.error(chalk.red(`Invalid --type. Valid: ${VALID_TYPES.join(', ')}`));
      process.exit(1);
    }

    const params = new URLSearchParams();
    if (opts.type) params.set('type', opts.type);
    if (opts.provider) params.set('provider_type', opts.provider);
    const query = params.toString();

    const api = await ApiClient.create();
    const { items, total, truncated } = await fetchAllPages<ParameterGroup>(
      api,
      `/api/v1/parameter-groups${query ? `?${query}` : ''}`,
    );

    if (isJsonMode()) {
      jsonOutput(items);
      return;
    }

    if (items.length === 0) {
      console.log('No parameter groups found.');
      return;
    }

    console.log(formatTable(
      ['ID', 'NAME', 'TYPE', 'PROVIDER', 'SYSTEM', 'DEFAULT', 'CREATED'],
      items.map(g => [
        String(g.id),
        g.name,
        g.type,
        g.provider_type,
        g.is_system ? chalk.dim('yes') : 'no',
        g.is_default ? 'yes' : 'no',
        g.created_at ? formatDate(g.created_at) : '-',
      ]),
    ));

    if (truncated) {
      console.log(chalk.dim(`Showing ${items.length} of ${total}. Refine with the web console for the full list.`));
    }
  });

const createCommand = new Command('create')
  .description('Create a new parameter group')
  .option('--name <name>', 'Group name')
  .option('--type <type>', 'Type: cache | database | queue')
  .option('--provider <provider>', 'Provider type (e.g. redis, mysql)')
  .option('--family <family>', 'Optional family label (e.g. redis7.x)')
  .option('--description <text>', 'Optional description')
  .option('--parameters <json>', 'Parameters as JSON object or @path/to/file.json')
  .option('--locked <keys>', 'Comma-separated list of locked parameter keys')
  .option('--default', 'Mark as default group for this provider')
  .action(async (opts: {
    name?: string; type?: string; provider?: string; family?: string;
    description?: string; parameters?: string; locked?: string; default?: boolean;
  }) => {
    if (!opts.name || !opts.type || !opts.provider || !opts.parameters) {
      console.error(chalk.red('--name, --type, --provider, and --parameters are required.'));
      process.exit(1);
    }
    if (!VALID_TYPES.includes(opts.type as ParameterGroupType)) {
      console.error(chalk.red(`Invalid --type. Valid: ${VALID_TYPES.join(', ')}`));
      process.exit(1);
    }

    const body: Record<string, unknown> = {
      name: opts.name,
      type: opts.type,
      provider_type: opts.provider,
      parameters: parseParametersFlag(opts.parameters),
    };
    if (opts.family) body.family = opts.family;
    if (opts.description) body.description = opts.description;
    if (opts.locked) body.locked_parameters = parseLockedFlag(opts.locked);
    if (opts.default) body.is_default = true;

    const api = await ApiClient.create();
    const spinner = isJsonMode() ? null : ora('Creating parameter group...').start();
    const res = await api.post<{ message: string; parameter_group: ParameterGroup }>('/api/v1/parameter-groups', body);

    if (isJsonMode()) {
      jsonOutput(res.parameter_group);
      return;
    }
    spinner!.succeed(`Created parameter group ${chalk.bold(res.parameter_group.name)} (${res.parameter_group.id})`);
  });

const getCommand = new Command('get')
  .description('Show a parameter group')
  .argument('<id>', 'Parameter group ID')
  .action(async (id: string) => {
    const api = await ApiClient.create();
    const res = await api.get<{ parameter_group: ParameterGroup }>(`/api/v1/parameter-groups/${id}`);

    if (isJsonMode()) {
      jsonOutput(res.parameter_group);
      return;
    }

    const g = res.parameter_group;
    const lines = [
      ['ID', String(g.id)],
      ['Name', g.name],
      ['Type', g.type],
      ['Provider', g.provider_type],
      ['Family', g.family ?? '-'],
      ['Description', g.description ?? '-'],
      ['System', g.is_system ? 'yes' : 'no'],
      ['Default', g.is_default ? 'yes' : 'no'],
      ['Active', g.is_active ? 'yes' : 'no'],
      ['Created', g.created_at ? formatDate(g.created_at) : '-'],
    ];

    const maxLabel = Math.max(...lines.map(([l]) => l!.length));
    for (const [label, value] of lines) {
      console.log(`${chalk.dim(label!.padEnd(maxLabel))}  ${value}`);
    }
    console.log('');
    console.log(chalk.bold('Parameters:'));
    for (const [k, v] of Object.entries(g.parameters)) {
      const locked = g.locked_parameters.includes(k) ? chalk.yellow(' [locked]') : '';
      console.log(`  ${chalk.dim(k)} = ${v}${locked}`);
    }
  });

const updateCommand = new Command('update')
  .description('Update a parameter group (non-system only)')
  .argument('<id>', 'Parameter group ID')
  .option('--name <name>', 'New name')
  .option('--description <text>', 'New description')
  .option('--parameters <json>', 'Replace parameters (JSON object or @file.json)')
  .option('--locked <keys>', 'Replace locked keys (comma-separated)')
  .option('--default', 'Mark as default')
  .option('--no-default', 'Unmark default')
  .option('--active', 'Mark as active')
  .option('--no-active', 'Mark as inactive')
  .action(async (id: string, opts: {
    name?: string; description?: string; parameters?: string; locked?: string;
    default?: boolean; active?: boolean;
  }) => {
    const body: Record<string, unknown> = {};
    if (opts.name !== undefined) body.name = opts.name;
    if (opts.description !== undefined) body.description = opts.description;
    if (opts.parameters !== undefined) body.parameters = parseParametersFlag(opts.parameters);
    if (opts.locked !== undefined) body.locked_parameters = parseLockedFlag(opts.locked);
    if (opts.default !== undefined) body.is_default = opts.default;
    if (opts.active !== undefined) body.is_active = opts.active;

    if (Object.keys(body).length === 0) {
      console.error(chalk.red('At least one option is required.'));
      process.exit(1);
    }

    const api = await ApiClient.create();
    const spinner = isJsonMode() ? null : ora('Updating parameter group...').start();
    const res = await api.put<{ message: string; parameter_group: ParameterGroup }>(
      `/api/v1/parameter-groups/${id}`,
      body,
    );

    if (isJsonMode()) {
      jsonOutput(res.parameter_group);
      return;
    }
    spinner!.succeed(`Updated parameter group ${chalk.bold(res.parameter_group.name)}`);
  });

const rmCommand = new Command('rm')
  .description('Delete a parameter group (non-system, not in use)')
  .argument('<id>', 'Parameter group ID')
  .option('--force', 'Skip confirmation')
  .action(async (id: string, opts: { force?: boolean }) => {
    if (!opts.force && !isJsonMode()) {
      const confirmed = await confirm({
        message: `Delete parameter group ${id}?`,
        default: false,
      });
      if (!confirmed) {
        console.log('Cancelled.');
        return;
      }
    }

    const api = await ApiClient.create();
    const spinner = isJsonMode() ? null : ora('Deleting parameter group...').start();
    await api.delete<{ message: string }>(`/api/v1/parameter-groups/${id}`);

    if (isJsonMode()) {
      jsonOutput({ status: 'deleted', id });
      return;
    }
    spinner!.succeed('Parameter group deleted');
  });

const cloneCommand = new Command('clone')
  .description('Clone a parameter group (typically a system group) into your team')
  .argument('<id>', 'Source parameter group ID')
  .option('--name <name>', 'Name for the clone (defaults to "<original> (Copy)")')
  .action(async (id: string, opts: { name?: string }) => {
    const api = await ApiClient.create();
    const spinner = isJsonMode() ? null : ora('Cloning parameter group...').start();
    const res = await api.post<{ message: string; parameter_group: ParameterGroup }>(
      `/api/v1/parameter-groups/${id}/clone`,
      opts.name ? { name: opts.name } : {},
    );

    if (isJsonMode()) {
      jsonOutput(res.parameter_group);
      return;
    }
    spinner!.succeed(`Cloned to ${chalk.bold(res.parameter_group.name)} (${res.parameter_group.id})`);
  });

export const parameterGroupsCommand = new Command('parameter-groups')
  .description('Manage cache / database / queue parameter groups')
  .alias('pg')
  .addCommand(lsCommand)
  .addCommand(createCommand)
  .addCommand(getCommand)
  .addCommand(updateCommand)
  .addCommand(rmCommand)
  .addCommand(cloneCommand);
