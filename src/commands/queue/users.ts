import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { formatTable, statusColor, formatDate } from '../../lib/output.js';
import { isJsonMode, jsonOutput, jsonEnvelope } from '../../lib/json-mode.js';
import { confirmDestruction } from '../../lib/interactive.js';
import { ResourceNotFoundError, UsageError } from '../../lib/errors.js';
import { resolveQueue } from './shared.js';
import { parseAcls, formatAcl } from './acl.js';
import type { KafkaUser } from '../../types/api.js';

/** Kafka users (SASL/SCRAM) and their ACLs: `danube queue users`. */

const collect = (value: string, previous: string[]) => [...previous, value];

async function usersPath(api: ApiClient, queueName: string, exact = true): Promise<{ base: string }> {
  const queue = await resolveQueue(api, queueName, exact);
  return { base: `/api/v1/queue/${queue.id}/kafka-users` };
}

async function findUser(api: ApiClient, base: string, nameOrId: string): Promise<KafkaUser> {
  const { data } = await api.get<{ data: KafkaUser[] }>(base);
  const user = data.find((u) => u.name === nameOrId || u.id === nameOrId);
  if (!user) throw new ResourceNotFoundError(`Kafka user '${nameOrId}' not found.`);
  return user;
}

function printUserDetails(user: KafkaUser): void {
  console.log(`${chalk.bold('Username')}  ${user.username}`);
  console.log(`${chalk.bold('Status')}    ${statusColor(user.status)}${user.status_message ? ` (${user.status_message})` : ''}`);
  console.log(`${chalk.bold('ACLs')}      ${user.acls.length === 0 ? 'none (no access)' : ''}`);
  for (const rule of user.acls) console.log(`  ${formatAcl(rule)}`);
}

/** The password is returned once; say so, and keep it out of anything but the one place it is shown. */
function printPasswordOnce(user: KafkaUser): void {
  if (!user.password) return;
  console.log(`\n${chalk.bold('Password')}  ${user.password}`);
  console.log(chalk.yellow('Save it now: it is shown only this once. Lost? Run `danube queue users rotate-password`.'));
}

async function listUsers(queueName: string): Promise<void> {
  const api = await ApiClient.create();
  const { base } = await usersPath(api, queueName, false);
  const res = await api.get<{ data: KafkaUser[]; meta?: unknown }>(base);

  if (isJsonMode()) {
    // The limits (max_users, max_acl_rules, max_name_length) travel with the list.
    jsonEnvelope(res.data, { meta: { count: res.data.length, ...(res.meta as Record<string, unknown> | undefined) } });
    return;
  }
  if (res.data.length === 0) {
    console.log('No Kafka users. Create one with: danube queue users create <queue> <name> --acl <spec>');
    return;
  }
  console.log(
    formatTable(
      ['NAME', 'USERNAME', 'STATUS', 'ACLS', 'CREATED'],
      res.data.map((u) => [
        u.name,
        u.username,
        statusColor(u.status),
        u.acls.map(formatAcl).join('\n') || '-',
        u.created_at ? formatDate(u.created_at) : '-',
      ]),
    ),
  );
}

const ACL_HELP = 'ACL rule, repeatable: <resource>:<name>:<literal|prefix>:<ops>, e.g. topic:orders.:prefix:read,describe, group:billing:literal:read, cluster:describe';

const createCommand = new Command('create')
  .description('Create a Kafka user (the password is shown once)')
  .argument('<queue>', 'Queue name or ID')
  .argument('<name>', 'User name: lowercase letters, digits and hyphens')
  .option('--acl <spec>', ACL_HELP, collect, [] as string[])
  .action(async (queueName: string, name: string, opts: { acl: string[] }) => {
    const acls = parseAcls(opts.acl);
    const api = await ApiClient.create();
    const { base } = await usersPath(api, queueName);
    const { data: user } = await api.post<{ data: KafkaUser }>(base, { name, acls });

    if (isJsonMode()) {
      jsonOutput(user);
      return;
    }
    console.log(chalk.green(`Kafka user '${user.name}' created.`));
    printUserDetails(user);
    printPasswordOnce(user);
    if (acls.length === 0) console.log(chalk.dim('\nNo --acl given: the user cannot do anything yet. Grant access with `queue users update`.'));
  });

const updateCommand = new Command('update')
  .description('Replace the ACL rules of a Kafka user')
  .argument('<queue>', 'Queue name or ID')
  .argument('<name>', 'User name')
  .option('--acl <spec>', `${ACL_HELP}. Replaces ALL existing rules`, collect, [] as string[])
  .option('--none', 'Remove all access (an empty rule list)')
  .action(async (queueName: string, name: string, opts: { acl: string[]; none?: boolean }) => {
    if (opts.acl.length > 0 && opts.none) throw new UsageError('Use either --acl or --none, not both.');
    if (opts.acl.length === 0 && !opts.none) {
      throw new UsageError('Pass at least one --acl (this replaces all rules), or --none to remove all access.');
    }
    const acls = parseAcls(opts.acl);
    const api = await ApiClient.create();
    const { base } = await usersPath(api, queueName);
    const existing = await findUser(api, base, name);
    const { data: user } = await api.put<{ data: KafkaUser }>(`${base}/${existing.id}`, { acls });

    if (isJsonMode()) {
      jsonOutput(user);
      return;
    }
    console.log(chalk.green(`Kafka user '${user.name}' updated.`));
    printUserDetails(user);
  });

const rmCommand = new Command('rm')
  .description('Delete a Kafka user')
  .argument('<queue>', 'Queue name or ID')
  .argument('<name>', 'User name')
  .option('-f, --force', 'Skip the confirmation prompt')
  .option('-y, --yes', 'Alias for --force')
  .action(async (queueName: string, name: string, opts: { force?: boolean; yes?: boolean }) => {
    const api = await ApiClient.create();
    const { base } = await usersPath(api, queueName);
    const user = await findUser(api, base, name);

    const confirmed = await confirmDestruction(
      user.name,
      `Delete Kafka user '${user.name}'? Clients using it lose access.`,
      opts.force || opts.yes,
    );
    if (!confirmed) return;

    await api.delete(`${base}/${user.id}`);

    if (isJsonMode()) {
      jsonOutput({ deleted: true, id: user.id, name: user.name });
      return;
    }
    console.log(chalk.green(`Kafka user '${user.name}' is being deleted.`));
  });

const rotateCommand = new Command('rotate-password')
  .description('Issue a new password for a Kafka user (the old one stops working)')
  .argument('<queue>', 'Queue name or ID')
  .argument('<name>', 'User name')
  .option('-f, --force', 'Skip the confirmation prompt')
  .option('-y, --yes', 'Alias for --force')
  .action(async (queueName: string, name: string, opts: { force?: boolean; yes?: boolean }) => {
    const api = await ApiClient.create();
    const { base } = await usersPath(api, queueName);
    const existing = await findUser(api, base, name);

    const confirmed = await confirmDestruction(
      existing.name,
      `Rotate the password of Kafka user '${existing.name}'? Clients using the old one are disconnected.`,
      opts.force || opts.yes,
    );
    if (!confirmed) return;

    const { data: user } = await api.post<{ data: KafkaUser }>(`${base}/${existing.id}/rotate-password`);

    if (isJsonMode()) {
      jsonOutput(user);
      return;
    }
    console.log(chalk.green(`Password of Kafka user '${user.name}' rotated.`));
    console.log(`${chalk.bold('Username')}  ${user.username}`);
    console.log(`${chalk.bold('Status')}    ${statusColor(user.status)}`);
    printPasswordOnce(user);
    console.log(chalk.dim('The old password keeps working until the cluster applies the new one (status active).'));
  });

// `users <queue>` lists; the subcommands win when the first argument is their name.
export const usersCommand = new Command('users')
  .description('Manage Kafka users and their ACLs. With a queue name, lists them')
  .argument('<queue>', 'Queue name or ID')
  .action(listUsers)
  .addCommand(new Command('ls').description('List Kafka users').argument('<queue>', 'Queue name or ID').action(listUsers))
  .addCommand(createCommand)
  .addCommand(updateCommand)
  .addCommand(rmCommand)
  .addCommand(rotateCommand);
