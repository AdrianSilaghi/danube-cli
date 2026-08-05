import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { input } from '@inquirer/prompts';
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
 * Managed RabbitMQ brokers.
 *
 * The API has been complete for a while — CRUD, start/stop, connection info,
 * metrics and the full diagnostics surface — with no CLI to reach it, so
 * automation had to hand-roll HTTP for queues while every other product had
 * commands.
 */

interface QueueInstance {
  id: string;
  name: string;
  status: string;
  resource_profile?: string | null;
  version?: string | null;
  datacenter?: string | null;
  endpoint?: string | null;
  monthly_cost_dollars?: number | string | null;
  created_at: string;
}

const LIST_PATH = '/api/v1/queue';

const diagnosticsTarget = {
  noun: 'queue instance',
  kind: 'queue',
  listPath: LIST_PATH,
  resourcePath: (id: string) => `/api/v1/queue/${id}`,
};

async function resolveQueue(api: ApiClient, nameOrId: string): Promise<QueueInstance> {
  return resolveResource<QueueInstance>(api, LIST_PATH, 'queue', nameOrId);
}

const lsCommand = new Command('ls')
  .description('List all queue instances')
  .action(async () => {
    const api = await ApiClient.create();
    const { items, total, truncated } = await fetchAllPages<QueueInstance>(api, LIST_PATH);

    if (isJsonMode()) {
      jsonOutput(items);
      return;
    }

    if (items.length === 0) {
      console.log('No queue instances found.');
      return;
    }

    console.log(
      formatTable(
        ['ID', 'NAME', 'STATUS', 'PROFILE', 'VERSION', 'ENDPOINT', 'COST/MO', 'CREATED'],
        items.map((q) => [
          q.id,
          q.name,
          statusColor(q.status),
          q.resource_profile ?? '-',
          q.version ?? '-',
          q.endpoint ?? '-',
          `€${q.monthly_cost_dollars ?? '-'}/mo`,
          formatDate(q.created_at),
        ]),
      ),
    );

    if (truncated) {
      console.log(chalk.dim(`Showing ${items.length} of ${total}.`));
    }
  });

const createCommand = new Command('create')
  .description('Create a queue instance')
  .option('--name <name>', 'Instance name (lowercase, alphanumeric, hyphens)')
  .option('--profile <profile>', 'Resource profile slug')
  .option('--version <version>', 'RabbitMQ version (optional — the platform picks a default)')
  .option('--datacenter <dc>', 'Datacenter region', 'fsn1')
  .action(async (opts: Record<string, string>) => {
    const api = await ApiClient.create();

    const name = await promptOr('name', opts.name, () => input({ message: 'Instance name:' }));
    const resourceProfile = await promptOr('profile', opts.profile, () =>
      input({ message: 'Resource profile slug:' }),
    );

    const spinner = isJsonMode() ? null : ora('Creating queue instance...').start();

    try {
      const body: Record<string, unknown> = {
        name,
        resource_profile: resourceProfile,
        datacenter: opts.datacenter ?? 'fsn1',
      };
      if (opts.version) body.version = opts.version;

      const created = await api.post<{ instance?: QueueInstance } & QueueInstance>(LIST_PATH, body);
      const instance = created.instance ?? created;

      spinner?.succeed(`Queue instance '${instance.name}' created.`);

      if (isJsonMode()) {
        jsonOutput(instance);
        return;
      }

      // Provisioning is asynchronous. Say how to wait, rather than leaving the
      // caller to poll the status string — the documented way to hang forever.
      console.log(
        chalk.dim(
          `\nProvisioning is asynchronous. Poll status_details.operation.terminal:\n  danube queue get ${instance.name} --json`,
        ),
      );
    } catch (error) {
      spinner?.fail('Failed to create queue instance.');
      throw error;
    }
  });

const getCommand = new Command('get')
  .description('Show a queue instance')
  .argument('<name-or-id>', 'Queue name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const instance = await resolveQueue(api, nameOrId);

    const detail = await api.get<Record<string, unknown>>(`/api/v1/queue/${instance.id}`);

    if (isJsonMode()) {
      jsonOutput(detail);
      return;
    }

    const q = (detail.instance as QueueInstance | undefined) ?? instance;
    const status = detail.status_details as
      | { summary?: string; operation?: { terminal?: boolean } }
      | undefined;

    printDetails([
      ['ID', q.id],
      ['Name', q.name],
      ['Status', statusColor(q.status)],
      ['Summary', status?.summary ?? '-'],
      ['Settled', status?.operation?.terminal === undefined ? '-' : String(status.operation.terminal)],
      ['Profile', q.resource_profile ?? '-'],
      ['Version', q.version ?? '-'],
      ['Management UI', String(detail.management_url ?? '-')],
      ['Created', formatDate(q.created_at)],
    ]);
  });

const updateCommand = new Command('update')
  .description('Update a queue instance')
  .argument('<name-or-id>', 'Queue name or ID')
  .option('--profile <profile>', 'New resource profile slug')
  .option('--automated-snapshots <bool>', 'Enable or disable automated snapshots (true|false)')
  .action(async (nameOrId: string, opts: Record<string, string>) => {
    const body: Record<string, unknown> = {};
    if (opts.profile) body.resource_profile = opts.profile;
    if (opts.automatedSnapshots !== undefined) {
      body.automated_snapshots_enabled = opts.automatedSnapshots === 'true';
    }

    if (Object.keys(body).length === 0) {
      console.error(chalk.yellow('Nothing to update. Pass --profile or --automated-snapshots.'));
      process.exitCode = 2;
      return;
    }

    const api = await ApiClient.create();
    const instance = await resolveQueue(api, nameOrId);
    const updated = await api.put<Record<string, unknown>>(`/api/v1/queue/${instance.id}`, body);

    if (isJsonMode()) {
      jsonOutput(updated);
      return;
    }

    console.log(chalk.green(`Queue instance '${instance.name}' updated.`));
  });

const rmCommand = new Command('rm')
  .description('Delete a queue instance')
  .argument('<name-or-id>', 'Queue name or ID')
  .option('--force', 'Skip the confirmation prompt')
  .action(async (nameOrId: string, opts: Record<string, boolean>) => {
    const api = await ApiClient.create();
    const instance = await resolveQueue(api, nameOrId);

    const confirmed = await confirmDestruction(
      instance.name,
      `Delete queue instance '${instance.name}'? This destroys its data.`,
      opts.force,
    );
    if (!confirmed) return;

    await api.delete(`/api/v1/queue/${instance.id}`);

    if (isJsonMode()) {
      jsonOutput({ deleted: true, id: instance.id, name: instance.name });
      return;
    }

    console.log(chalk.green(`Queue instance '${instance.name}' deleted.`));
  });

function lifecycleCommand(verb: 'start' | 'stop'): Command {
  return new Command(verb)
    .description(`${verb === 'start' ? 'Start' : 'Stop'} a queue instance`)
    .argument('<name-or-id>', 'Queue name or ID')
    .action(async (nameOrId: string) => {
      const api = await ApiClient.create();
      const instance = await resolveQueue(api, nameOrId);
      const res = await api.post<Record<string, unknown>>(`/api/v1/queue/${instance.id}/${verb}`);

      if (isJsonMode()) {
        jsonOutput(res);
        return;
      }

      console.log(
        chalk.green(`Queue instance '${instance.name}' ${verb === 'start' ? 'starting' : 'stopping'}.`),
      );
      console.log(chalk.dim('This is asynchronous — poll status_details.operation.terminal.'));
    });
}

const connectionInfoCommand = new Command('connection-info')
  .description('Show connection details for a queue instance')
  .argument('<name-or-id>', 'Queue name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const instance = await resolveQueue(api, nameOrId);
    const info = await api.get<Record<string, unknown>>(`/api/v1/queue/${instance.id}/connection-info`);

    if (isJsonMode()) {
      jsonOutput(info);
      return;
    }

    printDetails(Object.entries(info).map(([k, v]) => [k, String(v ?? '-')]));
  });

const metricsCommand = new Command('metrics')
  .description('Show metrics for a queue instance')
  .argument('<name-or-id>', 'Queue name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const instance = await resolveQueue(api, nameOrId);
    const metrics = await api.get<Record<string, unknown>>(`/api/v1/queue/${instance.id}/metrics`);

    if (isJsonMode()) {
      jsonOutput(metrics);
      return;
    }

    printDetails(Object.entries(metrics).map(([k, v]) => [k, String(v ?? '-')]));
  });

export const queueCommand = new Command('queue')
  .alias('queues')
  .description('Manage managed RabbitMQ queue instances')
  .addCommand(lsCommand)
  .addCommand(createCommand)
  .addCommand(getCommand)
  .addCommand(updateCommand)
  .addCommand(rmCommand)
  .addCommand(lifecycleCommand('start'))
  .addCommand(lifecycleCommand('stop'))
  .addCommand(connectionInfoCommand)
  .addCommand(metricsCommand)
  .addCommand(createDiagnoseCommand(diagnosticsTarget))
  .addCommand(createLogsCommand(diagnosticsTarget))
  .addCommand(createEventsCommand(diagnosticsTarget));
