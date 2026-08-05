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
import {
  createDiagnoseCommand,
  createLogsCommand,
  createEventsCommand,
} from '../../lib/diagnostics/commands.js';

/**
 * Managed apps — WordPress, n8n, Ghost and friends.
 *
 * Deliberately no `upgrade` or `rollback` command: the API does not expose
 * them. An upgrade is a decision with a blast radius, and the platform only
 * reports the outcome (`app.upgrade_failed`, `app.upgrade_auto_rolled_back`)
 * rather than accepting one over the API. A command that pretended otherwise
 * would be worse than its absence.
 */

interface AppInstance {
  id: string;
  name: string;
  app_type: string;
  status: string;
  version?: string | null;
  resource_profile?: string | null;
  subdomain?: string | null;
  url?: string | null;
  admin_user?: string | null;
  monthly_cost_dollars?: number | string | null;
  created_at: string;
}

const LIST_PATH = '/api/v1/apps';

const diagnosticsTarget = {
  noun: 'app instance',
  kind: 'app',
  listPath: LIST_PATH,
  resourcePath: (id: string) => `/api/v1/apps/${id}`,
};

async function resolveApp(api: ApiClient, nameOrId: string): Promise<AppInstance> {
  return resolveResource<AppInstance>(api, LIST_PATH, 'app', nameOrId);
}

const catalogCommand = new Command('catalog')
  .description('List the apps available to install, with their versions')
  .action(async () => {
    const api = await ApiClient.create();
    const catalog = await api.get<{ data?: unknown[] } & Record<string, unknown>>(`${LIST_PATH}/catalog`);

    if (isJsonMode()) {
      jsonOutput(catalog);
      return;
    }

    const entries = (catalog.data ?? []) as Array<Record<string, unknown>>;
    if (entries.length === 0) {
      console.log('No apps available.');
      return;
    }

    console.log(
      formatTable(
        ['SLUG', 'NAME', 'VERSIONS'],
        entries.map((a) => [
          String(a.slug ?? a.app_type ?? '-'),
          String(a.name ?? '-'),
          Array.isArray(a.versions) ? a.versions.map(String).join(', ') : String(a.version ?? '-'),
        ]),
      ),
    );
  });

const lsCommand = new Command('ls')
  .description('List all app instances')
  .action(async () => {
    const api = await ApiClient.create();
    const { items, total, truncated } = await fetchAllPages<AppInstance>(api, LIST_PATH);

    if (isJsonMode()) {
      jsonOutput(items);
      return;
    }

    if (items.length === 0) {
      console.log('No app instances found.');
      return;
    }

    console.log(
      formatTable(
        ['ID', 'NAME', 'TYPE', 'STATUS', 'VERSION', 'URL', 'COST/MO', 'CREATED'],
        items.map((a) => [
          a.id,
          a.name,
          a.app_type,
          statusColor(a.status),
          a.version ?? '-',
          a.url ?? '-',
          `€${a.monthly_cost_dollars ?? '-'}/mo`,
          formatDate(a.created_at),
        ]),
      ),
    );

    if (truncated) {
      console.log(chalk.dim(`Showing ${items.length} of ${total}.`));
    }
  });

const createCommand = new Command('create')
  .description('Create an app instance')
  .option('--type <type>', 'App type (see: danube apps catalog)')
  .option('--name <name>', 'Instance name')
  .option('--subdomain <subdomain>', 'Subdomain, unique across the platform')
  .option('--profile <profile>', 'Resource profile slug')
  .option('--version <version>', 'Specific version (optional — the platform picks a default)')
  .option('--admin-user <user>', 'Administrator username (optional)')
  .option('--datacenter <dc>', 'Datacenter region', 'fsn1')
  .action(async (opts: Record<string, string>) => {
    const api = await ApiClient.create();

    const appType = await promptOr('type', opts.type, () =>
      select({
        message: 'App type:',
        choices: [
          { value: 'wordpress', name: 'WordPress' },
          { value: 'n8n', name: 'n8n' },
          { value: 'ghost', name: 'Ghost' },
        ],
      }),
    );
    const name = await promptOr('name', opts.name, () => input({ message: 'Instance name:' }));
    const subdomain = await promptOr('subdomain', opts.subdomain, () => input({ message: 'Subdomain:' }));
    const resourceProfile = await promptOr('profile', opts.profile, () =>
      input({ message: 'Resource profile slug:' }),
    );

    const spinner = isJsonMode() ? null : ora('Creating app instance...').start();

    try {
      const body: Record<string, unknown> = {
        app_type: appType,
        name,
        subdomain,
        resource_profile: resourceProfile,
        datacenter: opts.datacenter ?? 'fsn1',
      };
      if (opts.version) body.version = opts.version;
      if (opts.adminUser) body.admin_user = opts.adminUser;

      const created = await api.post<{ instance?: AppInstance } & AppInstance>(LIST_PATH, body);
      const instance = created.instance ?? created;

      spinner?.succeed(`App instance '${instance.name}' created.`);

      if (isJsonMode()) {
        jsonOutput(created);
        return;
      }

      console.log(
        chalk.dim(
          `\nProvisioning is asynchronous. Poll status_details.operation.terminal:\n  danube apps get ${instance.name} --json`,
        ),
      );
      console.log(
        chalk.dim(`Retrieve the generated credentials with:\n  danube apps credentials ${instance.name}`),
      );
    } catch (error) {
      spinner?.fail('Failed to create app instance.');
      throw error;
    }
  });

const getCommand = new Command('get')
  .description('Show an app instance')
  .argument('<name-or-id>', 'App name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const instance = await resolveApp(api, nameOrId);
    const detail = await api.get<Record<string, unknown>>(`/api/v1/apps/${instance.id}`);

    if (isJsonMode()) {
      jsonOutput(detail);
      return;
    }

    const a = (detail.instance as AppInstance | undefined) ?? instance;
    const status = detail.status_details as
      | { summary?: string; operation?: { terminal?: boolean } }
      | undefined;

    printDetails([
      ['ID', a.id],
      ['Name', a.name],
      ['Type', a.app_type],
      ['Status', statusColor(a.status)],
      ['Summary', status?.summary ?? '-'],
      ['Settled', status?.operation?.terminal === undefined ? '-' : String(status.operation.terminal)],
      ['Version', a.version ?? '-'],
      ['Profile', a.resource_profile ?? '-'],
      ['URL', a.url ?? '-'],
      ['Created', formatDate(a.created_at)],
    ]);
  });

const updateCommand = new Command('update')
  .description('Update an app instance')
  .argument('<name-or-id>', 'App name or ID')
  .option('--profile <profile>', 'New resource profile slug')
  .action(async (nameOrId: string, opts: Record<string, string>) => {
    if (!opts.profile) {
      console.error(chalk.yellow('Nothing to update. Pass --profile.'));
      process.exitCode = 2;
      return;
    }

    const api = await ApiClient.create();
    const instance = await resolveApp(api, nameOrId);
    const updated = await api.put<Record<string, unknown>>(`/api/v1/apps/${instance.id}`, {
      resource_profile: opts.profile,
    });

    if (isJsonMode()) {
      jsonOutput(updated);
      return;
    }

    console.log(chalk.green(`App instance '${instance.name}' updated.`));
  });

const rmCommand = new Command('rm')
  .description('Delete an app instance')
  .argument('<name-or-id>', 'App name or ID')
  .option('--force', 'Skip the confirmation prompt')
  .action(async (nameOrId: string, opts: Record<string, boolean>) => {
    const api = await ApiClient.create();
    const instance = await resolveApp(api, nameOrId);

    const confirmed = await confirmDestruction(
      instance.name,
      `Delete app instance '${instance.name}'? This destroys its data.`,
      opts.force,
    );
    if (!confirmed) return;

    await api.delete(`/api/v1/apps/${instance.id}`);

    if (isJsonMode()) {
      jsonOutput({ deleted: true, id: instance.id, name: instance.name });
      return;
    }

    console.log(chalk.green(`App instance '${instance.name}' deleted.`));
  });

const restartCommand = new Command('restart')
  .description('Restart an app instance')
  .argument('<name-or-id>', 'App name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const instance = await resolveApp(api, nameOrId);
    const res = await api.post<Record<string, unknown>>(`/api/v1/apps/${instance.id}/restart`);

    if (isJsonMode()) {
      jsonOutput(res);
      return;
    }

    console.log(chalk.green(`App instance '${instance.name}' restarting.`));
    console.log(chalk.dim('This is asynchronous — poll status_details.operation.terminal.'));
  });

const credentialsCommand = new Command('credentials')
  .description('Show the generated credentials for an app instance')
  .argument('<name-or-id>', 'App name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const instance = await resolveApp(api, nameOrId);
    const creds = await api.get<Record<string, unknown>>(`/api/v1/apps/${instance.id}/credentials`);

    if (isJsonMode()) {
      jsonOutput(creds);
      return;
    }

    printDetails(Object.entries(creds).map(([k, v]) => [k, String(v ?? '-')]));
    // Printed to a terminal, so very likely to survive in scrollback or a
    // screen share. Say so rather than pretending it is not a secret.
    console.log(chalk.yellow('\nThese are secrets. They are now in your terminal history.'));
  });

const metricsCommand = new Command('metrics')
  .description('Show metrics for an app instance')
  .argument('<name-or-id>', 'App name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const instance = await resolveApp(api, nameOrId);
    const metrics = await api.get<Record<string, unknown>>(`/api/v1/apps/${instance.id}/metrics`);

    if (isJsonMode()) {
      jsonOutput(metrics);
      return;
    }

    printDetails(Object.entries(metrics).map(([k, v]) => [k, String(v ?? '-')]));
  });

export const appsCommand = new Command('apps')
  .alias('app')
  .description('Manage managed apps (WordPress, n8n, Ghost)')
  .addCommand(catalogCommand)
  .addCommand(lsCommand)
  .addCommand(createCommand)
  .addCommand(getCommand)
  .addCommand(updateCommand)
  .addCommand(rmCommand)
  .addCommand(restartCommand)
  .addCommand(credentialsCommand)
  .addCommand(metricsCommand)
  .addCommand(createDiagnoseCommand(diagnosticsTarget))
  .addCommand(createLogsCommand(diagnosticsTarget))
  .addCommand(createEventsCommand(diagnosticsTarget));
