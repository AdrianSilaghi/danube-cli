import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { input } from '@inquirer/prompts';
import { ApiClient } from '../../lib/api-client.js';
import { fetchAllPages } from '../../lib/paginate.js';
import { formatTable, statusColor, formatDate, printDetails } from '../../lib/output.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import { promptOr, confirmDestruction } from '../../lib/interactive.js';
import {
  createDiagnoseCommand,
  createLogsCommand,
  createEventsCommand,
} from '../../lib/diagnostics/commands.js';
import {
  QUEUE_PROVIDERS,
  isQueueProvider,
  planProblem,
  isKafkaConnectionInfo,
  PASSWORD_ENV_VAR,
  kcatSnippet,
  javaPropertiesSnippet,
  type KafkaConnectionInfo,
  type QueueProvider,
} from './kafka.js';
import { LIST_PATH, resolveQueue, type QueueInstance } from './shared.js';
import { usersCommand } from './users.js';
import { schemaRegistryCommand } from './schema-registry.js';
import { clientPropertiesCommand } from './client-properties.js';

/**
 * Managed message brokers: RabbitMQ and Kafka.
 *
 * The API has been complete for a while — CRUD, start/stop, connection info,
 * metrics and the full diagnostics surface — with no CLI to reach it, so
 * automation had to hand-roll HTTP for queues while every other product had
 * commands.
 */

const diagnosticsTarget = {
  noun: 'queue instance',
  kind: 'queue',
  listPath: LIST_PATH,
  resourcePath: (id: string) => `/api/v1/queue/${id}`,
};

const lsCommand = new Command('ls')
  .description('List all queue instances')
  .option('--provider <provider>', `Only list one provider: ${QUEUE_PROVIDERS.join(' or ')}`)
  .action(async (opts: { provider?: string }) => {
    if (opts.provider && !isQueueProvider(opts.provider)) {
      console.error(chalk.red(`Invalid provider "${opts.provider}". Valid: ${QUEUE_PROVIDERS.join(', ')}`));
      process.exitCode = 2;
      return;
    }

    const api = await ApiClient.create();
    const path = opts.provider ? `${LIST_PATH}?provider=${opts.provider}` : LIST_PATH;
    const { items, total, truncated } = await fetchAllPages<QueueInstance>(api, path);

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
        ['ID', 'NAME', 'PROVIDER', 'STATUS', 'PROFILE', 'VERSION', 'ENDPOINT', 'COST/MO', 'CREATED'],
        items.map((q) => [
          q.id,
          q.name,
          q.provider ?? '-',
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
  .option('--provider <provider>', `Broker: ${QUEUE_PROVIDERS.join(' or ')}`, 'rabbitmq')
  .option('--profile <profile>', 'Resource profile slug (Kafka: kafka-small, kafka-medium or kafka-large)')
  .option('--version <version>', 'Broker version, e.g. 4.3 for Kafka (optional — the platform picks a default). Write it as --version=4.3')
  .option('--datacenter <dc>', 'Datacenter region', 'fsn1')
  .action(async (opts: Record<string, string>) => {
    if (!isQueueProvider(opts.provider)) {
      console.error(chalk.red(`Invalid provider "${opts.provider}". Valid: ${QUEUE_PROVIDERS.join(', ')}`));
      process.exitCode = 2;
      return;
    }
    const provider: QueueProvider = opts.provider;
    const flagProblem = opts.profile ? planProblem(provider, opts.profile) : null;
    if (flagProblem) {
      console.error(chalk.red(flagProblem));
      process.exitCode = 2;
      return;
    }

    const api = await ApiClient.create();

    const name = await promptOr('name', opts.name, () => input({ message: 'Instance name:' }));
    const resourceProfile = await promptOr('profile', opts.profile, () =>
      input({ message: 'Resource profile slug:' }),
    );
    const promptedProblem = planProblem(provider, resourceProfile);
    if (promptedProblem) {
      console.error(chalk.red(promptedProblem));
      process.exitCode = 2;
      return;
    }

    const spinner = isJsonMode() ? null : ora('Creating queue instance...').start();

    try {
      const body: Record<string, unknown> = {
        name,
        provider,
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
      if (provider === 'kafka') {
        console.log(
          chalk.dim(`Once it is ready: danube queue connection-info ${instance.name}`),
        );
      }
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
      ['Provider', q.provider ?? '-'],
      ['Status', statusColor(q.status)],
      ['Summary', status?.summary ?? '-'],
      ['Settled', status?.operation?.terminal === undefined ? '-' : String(status.operation.terminal)],
      ['Profile', q.resource_profile ?? '-'],
      ['Version', q.version ?? '-'],
      // Kafka has no management UI; the row would only ever read "-".
      ...(q.provider === 'kafka' ? [] : [['Management UI', String(detail.management_url ?? '-')] as [string, string]]),
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

function printKafkaConnectionInfo(info: KafkaConnectionInfo & Record<string, unknown>): void {
  if (!info.bootstrap_servers) {
    // Still provisioning (or the endpoint is being set up): show whatever
    // state the API reports instead of snippets with nothing to connect to.
    printDetails([
      ['Status', info.status ?? 'provisioning'],
      ['Username', info.username ?? '-'],
    ]);
    console.log(chalk.dim('\nThe endpoint is not ready yet. Try again in a few minutes.'));
    return;
  }

  printDetails([
    ['Bootstrap servers', info.bootstrap_servers],
    ['Security protocol', info.security_protocol ?? 'SASL_SSL'],
    ['SASL mechanism', info.sasl_mechanism ?? 'SCRAM-SHA-512'],
    ['Username', info.username ?? '-'],
    ['Password', info.password ?? '(hidden: your role cannot read it)'],
  ]);

  const registry = info.schema_registry;
  if (registry) {
    console.log(chalk.bold('\nSchema Registry'));
    printDetails([
      ['Status', registry.status ?? '-'],
      ['URL', registry.url ?? '-'],
      ['Username', registry.username ?? '-'],
      ['Password', registry.password ?? '(hidden: your role cannot read it)'],
    ]);
  }

  console.log(chalk.dim(`\n${info.certificate ?? 'The certificate is publicly trusted, so no CA file is needed.'}`));
  console.log(chalk.bold('\nkcat'));
  console.log(chalk.dim(`Set the password first: export ${PASSWORD_ENV_VAR}=... (or read it with: danube queue connection-info <name> --json)`));
  console.log(kcatSnippet(info));
  console.log(chalk.bold('\nJava client properties'));
  console.log(chalk.dim('Replace <password> with the password. A backslash or quote in it needs escaping for both the properties file and JAAS.'));
  console.log(javaPropertiesSnippet(info));
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

    if (instance.provider === 'kafka' || isKafkaConnectionInfo(info)) {
      printKafkaConnectionInfo(info as KafkaConnectionInfo & Record<string, unknown>);
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
  .description('Manage managed RabbitMQ and Kafka queue instances')
  .addCommand(lsCommand)
  .addCommand(createCommand)
  .addCommand(getCommand)
  .addCommand(updateCommand)
  .addCommand(rmCommand)
  .addCommand(lifecycleCommand('start'))
  .addCommand(lifecycleCommand('stop'))
  .addCommand(connectionInfoCommand)
  .addCommand(clientPropertiesCommand)
  .addCommand(usersCommand)
  .addCommand(schemaRegistryCommand)
  .addCommand(metricsCommand)
  .addCommand(createDiagnoseCommand(diagnosticsTarget))
  .addCommand(createLogsCommand(diagnosticsTarget))
  .addCommand(createEventsCommand(diagnosticsTarget));
