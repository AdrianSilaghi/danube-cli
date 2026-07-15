import { Command } from 'commander';
import { randomBytes } from 'node:crypto';
import chalk from 'chalk';
import ora from 'ora';
import { input, select, password as passwordPrompt } from '@inquirer/prompts';
import { ApiClient } from '../../lib/api-client.js';
import { fetchAllPages } from '../../lib/paginate.js';
import { resolveResource } from '../../lib/resolve.js';
import { formatTable, statusColor, formatDate, printDetails } from '../../lib/output.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import { canPrompt, promptOr, confirmDestruction } from '../../lib/interactive.js';
import { MissingFlagsError } from '../../lib/errors.js';
import type {
  VpsInstance,
  VpsConnectionInfo,
  VpsImage,
  VpsImageGroup,
  VpsPlanInfo,
  PlansResponse,
} from '../../types/api.js';

function generatePassword(length = 24): string {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*';
  const bytes = randomBytes(length);
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

export const lsCommand = new Command('ls')
  .description('List all VPS instances')
  .action(async () => {
    const api = await ApiClient.create();
    const { items, total, truncated } = await fetchAllPages<VpsInstance>(api, '/api/v1/vps');

    if (isJsonMode()) {
      jsonOutput(items);
      return;
    }

    if (items.length === 0) {
      console.log('No VPS instances found.');
      return;
    }

    const rows = items.map(v => [
      v.id,
      v.name,
      statusColor(v.status),
      v.public_ip || '-',
      v.resource_profile,
      `${v.cpu_cores} ${v.cpu_allocation_type}`,
      `${v.memory_size_gb}GB`,
      `${v.storage_size_gb}GB`,
      `\u20AC${v.monthly_cost_dollars}/mo`,
      formatDate(v.created_at),
    ]);

    console.log(formatTable(
      ['ID', 'NAME', 'STATUS', 'IP', 'PLAN', 'CPU', 'RAM', 'DISK', 'COST/MO', 'CREATED'],
      rows,
    ));

    if (truncated) {
      console.log(chalk.dim(`Showing ${items.length} of ${total}. Refine with the web console for the full list.`));
    }
  });

export const createCommand = new Command('create')
  .description('Create a new VPS instance')
  .option('--name <name>', 'Instance name (lowercase, alphanumeric, hyphens)')
  .option('--image <image>', 'OS image ID (e.g. ubuntu-24.04)')
  .option('--plan <plan>', 'Resource profile slug (run interactively to list available plans)')
  .option('--cpu-type <type>', 'CPU allocation: shared or dedicated')
  .option('--network <stack>', 'Network stack: dual_stack, ipv4_only, ipv6_only')
  .option('--ssh-key-id <id>', 'SSH key ID for authentication')
  .option('--password <password>', 'Root password (min 12 chars)')
  .option('--datacenter <dc>', 'Datacenter region', 'fsn1')
  .action(async (opts: {
    name?: string; image?: string; plan?: string; cpuType?: string;
    network?: string; sshKeyId?: string; password?: string; datacenter: string;
  }) => {
    let sshKeyId = opts.sshKeyId;
    let pass = opts.password;
    let authMethod: string;

    const api = await ApiClient.create();

    const name = await promptOr('--name', opts.name, () => input({
      message: 'Instance name:',
      validate: (v: string) => /^[a-z0-9-]+$/.test(v.trim()) || 'Lowercase letters, numbers, and hyphens only',
    }));

    const image = await promptOr('--image', opts.image, async () => {
      const groupsRes = await api.get<{ groups: VpsImageGroup[] }>('/api/v1/vps/images/grouped');
      const imageChoices = groupsRes.groups.flatMap(g =>
        g.images.map(img => ({
          name: `${img.label} (${img.default_user})`,
          value: img.id,
        })),
      );
      return select({ message: 'Operating system:', choices: imageChoices });
    });

    const plan = await promptOr('--plan', opts.plan, async () => {
      const plansRes = await api.get<PlansResponse<VpsPlanInfo>>('/api/v1/vps/plans');
      if (plansRes.plans.length === 0) {
        throw new Error('No VPS plans are currently available from the API. Try again later or contact support.');
      }
      return select({
        message: 'Plan:',
        choices: plansRes.plans.map((p) => ({
          name: `${p.display_name} — ${p.cpu_cores} vCPU, ${p.memory_gb}GB RAM, ${p.storage_gb}GB — \u20AC${p.monthly_cost.toFixed(2)}/mo (${p.type})`,
          value: p.slug,
        })),
      });
    });

    const cpuType = opts.cpuType || (plan.endsWith('_shared') ? 'shared' : 'dedicated');

    if (!sshKeyId && !pass) {
      if (!canPrompt()) throw new MissingFlagsError(['--ssh-key-id or --password']);

      authMethod = await select({
        message: 'Authentication method:',
        choices: [
          { name: 'SSH Key', value: 'ssh_key' },
          { name: 'Password', value: 'password' },
        ],
      });

      if (authMethod === 'password') {
        const passwordChoice = await select({
          message: 'Password:',
          choices: [
            { name: 'Generate a secure password', value: 'generate' },
            { name: 'Enter manually', value: 'manual' },
          ],
        });

        if (passwordChoice === 'generate') {
          pass = generatePassword();
          if (!isJsonMode()) {
            console.log('');
            console.log(`  Generated password: ${chalk.bold.yellow(pass)}`);
            console.log(chalk.yellow('  Save this password now — it will not be shown again.'));
            console.log('');
          }
        } else {
          pass = await passwordPrompt({
            message: 'Root password (min 12 characters):',
            mask: '*',
            validate: (v: string) => v.length >= 12 || 'Password must be at least 12 characters',
          });
        }
      } else {
        sshKeyId = await input({
          message: 'SSH key ID:',
          validate: (v: string) => v.trim().length > 0 || 'SSH key ID is required',
        });
      }
    } else {
      authMethod = sshKeyId ? 'ssh_key' : 'password';
    }

    const body: Record<string, unknown> = {
      name: name.trim(),
      image,
      resource_profile: plan,
      cpu_allocation_type: cpuType,
      network_stack: opts.network || 'dual_stack',
      datacenter: opts.datacenter,
      auth_method: authMethod!,
    };

    if (sshKeyId) body.ssh_key_id = sshKeyId;
    if (pass) {
      body.password = pass;
      body.password_confirmation = pass;
    }

    const spinner = isJsonMode() ? null : ora('Creating VPS instance...').start();
    const res = await api.post<{ message: string; instance: VpsInstance }>('/api/v1/vps', body);

    if (isJsonMode()) {
      jsonOutput(res.instance);
      return;
    }
    spinner!.succeed(`Created VPS ${chalk.bold(res.instance.name)} (${res.instance.id})`);
  });

export const getCommand = new Command('get')
  .description('Show VPS instance details')
  .argument('<name-or-id>', 'VPS name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const instance = await resolveResource<VpsInstance>(api, '/api/v1/vps', 'VPS', nameOrId);
    const res = await api.get<{ instance: VpsInstance; connection_info: VpsConnectionInfo; monthly_cost: number }>(
      `/api/v1/vps/${instance.id}`,
    );

    if (isJsonMode()) {
      jsonOutput({ ...res.instance, monthly_cost: res.monthly_cost, connection_info: res.connection_info });
      return;
    }

    const v = res.instance;
    const sshCmd = v.public_ip ? `ssh root@${v.public_ip}` : '-';

    const lines: Array<[string, string]> = [
      ['ID', v.id],
      ['Name', v.name],
      ['Status', statusColor(v.status)],
      ['Plan', v.resource_profile],
      ['CPU', `${v.cpu_cores} cores (${v.cpu_allocation_type})`],
      ['Memory', `${v.memory_size_gb} GB`],
      ['Storage', `${v.storage_size_gb} GB`],
      ['Image', v.image],
      ['Datacenter', v.datacenter],
      ['IPv4', v.public_ip || '-'],
      ['IPv6', v.ipv6_address || '-'],
      ['Private IP', res.connection_info.private_ip ?? '-'],
      ['Internal DNS', res.connection_info.internal_fqdn ?? '-'],
      ['SSH', sshCmd],
      ['VNC', v.vnc_access_url || '-'],
      ['Cost', `\u20AC${res.monthly_cost ?? v.monthly_cost_dollars}/mo`],
      ['Created', formatDate(v.created_at)],
      ['Deployed', v.deployed_at ? formatDate(v.deployed_at) : '-'],
    ];

    printDetails(lines);
  });

export const updateCommand = new Command('update')
  .description('Update VPS instance (must be stopped)')
  .argument('<name-or-id>', 'VPS name or ID')
  .option('--plan <plan>', 'Resource profile')
  .option('--cpu-type <type>', 'CPU allocation: shared or dedicated')
  .option('--cpu-cores <cores>', 'Number of CPU cores')
  .option('--memory <gb>', 'Memory in GB')
  .option('--storage <gb>', 'Storage in GB')
  .option('--snapshots', 'Enable automated snapshots')
  .option('--no-snapshots', 'Disable automated snapshots')
  .action(async (nameOrId: string, opts: {
    plan?: string; cpuType?: string; cpuCores?: string;
    memory?: string; storage?: string; snapshots?: boolean;
  }) => {
    const body: Record<string, unknown> = {};

    if (opts.plan !== undefined) body.resource_profile = opts.plan;
    if (opts.cpuType !== undefined) body.cpu_allocation_type = opts.cpuType;
    if (opts.cpuCores !== undefined) body.cpu_cores = parseInt(opts.cpuCores, 10);
    if (opts.memory !== undefined) body.memory_size_gb = parseInt(opts.memory, 10);
    if (opts.storage !== undefined) body.storage_size_gb = parseInt(opts.storage, 10);
    if (opts.snapshots !== undefined) body.automated_snapshots_enabled = opts.snapshots;

    if (Object.keys(body).length === 0) {
      console.error(chalk.red('At least one option is required.'));
      process.exit(1);
    }

    const api = await ApiClient.create();
    const instance = await resolveResource<VpsInstance>(api, '/api/v1/vps', 'VPS', nameOrId);
    const spinner = isJsonMode() ? null : ora('Updating VPS instance...').start();

    const res = await api.put<{ message: string; instance: VpsInstance }>(`/api/v1/vps/${instance.id}`, body);

    if (isJsonMode()) {
      jsonOutput(res.instance);
      return;
    }
    spinner!.succeed(`Updated VPS ${chalk.bold(res.instance.name)}`);
  });

export const deleteCommand = new Command('rm')
  .alias('delete')
  .description('Delete a VPS instance')
  .argument('<name-or-id>', 'VPS name or ID')
  .option('-f, --force', 'Skip confirmation')
  .option('-y, --yes', 'Alias for --force')
  .action(async (nameOrId: string, opts: { force?: boolean; yes?: boolean }) => {
    const api = await ApiClient.create();
    const instance = await resolveResource<VpsInstance>(api, '/api/v1/vps', 'VPS', nameOrId);

    const proceed = await confirmDestruction(
      `deletion of VPS ${instance.name}`,
      `Are you sure you want to delete VPS ${instance.name} (${instance.id})? This cannot be undone.`,
      opts.force || opts.yes,
    );
    if (!proceed) {
      console.log('Cancelled.');
      return;
    }

    const spinner = isJsonMode() ? null : ora('Deleting VPS instance...').start();

    await api.delete<{ message: string }>(`/api/v1/vps/${instance.id}`);

    if (isJsonMode()) {
      jsonOutput({ status: 'deleted', id: instance.id });
      return;
    }
    spinner!.succeed('VPS instance deleted');
  });
