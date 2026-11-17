import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { printDetails, statusColor } from '../../lib/output.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import { confirmDestruction } from '../../lib/interactive.js';
import { resolveQueue } from './shared.js';
import type { SchemaRegistry } from '../../types/api.js';

/** The optional Schema Registry add-on of a Kafka cluster (billed monthly). */

const euros = (cents: number) => `EUR ${(cents / 100).toFixed(2)}`;

async function target(nameOrId: string): Promise<{ api: ApiClient; path: string; name: string }> {
  const api = await ApiClient.create();
  const queue = await resolveQueue(api, nameOrId, true);
  return { api, path: `/api/v1/queue/${queue.id}/schema-registry`, name: queue.name };
}

function printRegistry(reg: SchemaRegistry): void {
  if (!reg.enabled) {
    printDetails([
      ['Status', statusColor(reg.status)],
      ['Price', `${euros(reg.monthly_price_cents)}/month when enabled`],
    ]);
    return;
  }
  printDetails([
    ['Status', statusColor(reg.status)],
    ['URL', reg.url ?? '-'],
    ['Username', reg.username],
    ['Password', reg.password ?? '(hidden: your role cannot read it)'],
    ['Price', `${euros(reg.monthly_price_cents)}/month`],
  ]);
}

const unwrap = (res: { data: SchemaRegistry }) => res.data;

const showCommand = new Command('show')
  .description('Show the Schema Registry of a Kafka cluster')
  .argument('<queue>', 'Queue name or ID')
  .action(showRegistry);

async function showRegistry(nameOrId: string): Promise<void> {
  const { api, path } = await target(nameOrId);
  const reg = unwrap(await api.get<{ data: SchemaRegistry }>(path));

  if (isJsonMode()) {
    jsonOutput(reg);
    return;
  }
  printRegistry(reg);
  if (!reg.enabled) console.log(chalk.dim('\nEnable it with: danube queue schema-registry enable <queue>'));
}

const enableCommand = new Command('enable')
  .description('Enable the Schema Registry (billed monthly)')
  .argument('<queue>', 'Queue name or ID')
  .option('-y, --yes', 'Skip the price confirmation')
  .option('-f, --force', 'Alias for --yes')
  .action(async (nameOrId: string, opts: { yes?: boolean; force?: boolean }) => {
    const { api, path, name } = await target(nameOrId);
    const current = unwrap(await api.get<{ data: SchemaRegistry }>(path));
    if (current.enabled) {
      if (isJsonMode()) jsonOutput(current);
      else console.log(`Schema Registry is already enabled on '${name}' (${current.status}).`);
      return;
    }

    const confirmed = await confirmDestruction(
      name,
      `Enable the Schema Registry on '${name}' for ${euros(current.monthly_price_cents)}/month?`,
      opts.yes || opts.force,
    );
    if (!confirmed) return;

    const reg = unwrap(await api.post<{ data: SchemaRegistry }>(path));
    if (isJsonMode()) {
      jsonOutput(reg);
      return;
    }
    console.log(chalk.green(`Schema Registry enabled on '${name}' (${euros(reg.monthly_price_cents)}/month).`));
    console.log(chalk.dim('Provisioning is asynchronous: check `danube queue schema-registry show` until the status is ready.'));
    printRegistry(reg);
  });

const disableCommand = new Command('disable')
  .description('Disable the Schema Registry')
  .argument('<queue>', 'Queue name or ID')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .option('-f, --force', 'Alias for --yes')
  .action(async (nameOrId: string, opts: { yes?: boolean; force?: boolean }) => {
    const { api, path, name } = await target(nameOrId);
    const confirmed = await confirmDestruction(
      name,
      `Disable the Schema Registry on '${name}'? Clients lose the registry and billing stops. Registered schemas stay in the cluster (the _schemas topic) and come back if you enable it again.`,
      opts.yes || opts.force,
    );
    if (!confirmed) return;

    await api.delete(path);
    if (isJsonMode()) {
      jsonOutput({ disabled: true, queue: name });
      return;
    }
    console.log(chalk.green(`Schema Registry is being disabled on '${name}'; billing stops once it is removed.`));
  });

const rotateCommand = new Command('rotate-password')
  .description('Issue a new Schema Registry password')
  .argument('<queue>', 'Queue name or ID')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .option('-f, --force', 'Alias for --yes')
  .action(async (nameOrId: string, opts: { yes?: boolean; force?: boolean }) => {
    const { api, path, name } = await target(nameOrId);
    const confirmed = await confirmDestruction(
      name,
      `Rotate the Schema Registry password on '${name}'? Clients using the old one stop working.`,
      opts.yes || opts.force,
    );
    if (!confirmed) return;

    const reg = unwrap(await api.post<{ data: SchemaRegistry }>(`${path}/rotate-password`));
    if (isJsonMode()) {
      jsonOutput(reg);
      return;
    }
    console.log(chalk.green('Schema Registry password rotated.'));
    printRegistry(reg);
    if (reg.password) console.log(chalk.yellow('Save the password now.'));
  });

// `schema-registry <queue>` shows; the subcommands win when the first argument is their name.
export const schemaRegistryCommand = new Command('schema-registry')
  .description('Manage the Schema Registry add-on of a Kafka cluster. With a queue name, shows it')
  .argument('<queue>', 'Queue name or ID')
  .action(showRegistry)
  .addCommand(showCommand)
  .addCommand(enableCommand)
  .addCommand(disableCommand)
  .addCommand(rotateCommand);
