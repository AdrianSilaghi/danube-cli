import { Command } from 'commander';
import { randomBytes } from 'node:crypto';
import chalk from 'chalk';
import ora from 'ora';
import { input, select, password as passwordPrompt, confirm } from '@inquirer/prompts';
import { ApiClient } from '../../lib/api-client.js';
import { formatTable, statusColor, formatDate } from '../../lib/output.js';
import type {
  VpsInstance,
  VpsConnectionInfo,
  VpsImage,
  VpsImageGroup,
  PaginatedResponse,
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
    const res = await api.get<PaginatedResponse<VpsInstance>>('/api/v1/vps');

    if (res.data.length === 0) {
      console.log('No VPS instances found.');
      return;
    }

    const rows = res.data.map(v => [
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
  });

export const createCommand = new Command('create')
  .description('Create a new VPS instance')
  .option('--name <name>', 'Instance name (lowercase, alphanumeric, hyphens)')
  .option('--image <image>', 'OS image ID (e.g. ubuntu-24.04)')
  .option('--plan <plan>', 'Resource profile (e.g. nano_shared, small)')
  .option('--cpu-type <type>', 'CPU allocation: shared or dedicated')
  .option('--network <stack>', 'Network stack: dual_stack, ipv4_only, ipv6_only')
  .option('--ssh-key-id <id>', 'SSH key ID for authentication')
  .option('--password <password>', 'Root password (min 12 chars)')
  .option('--datacenter <dc>', 'Datacenter region', 'fsn1')
  .action(async (opts: {
    name?: string; image?: string; plan?: string; cpuType?: string;
    network?: string; sshKeyId?: string; password?: string; datacenter: string;
  }) => {
    let name = opts.name;
    let image = opts.image;
    let plan = opts.plan;
    let cpuType = opts.cpuType;
    let authMethod: string;
    let sshKeyId = opts.sshKeyId;
    let pass = opts.password;

    const api = await ApiClient.create();

    if (!name) {
      name = await input({
        message: 'Instance name:',
        validate: (v: string) => /^[a-z0-9-]+$/.test(v.trim()) || 'Lowercase letters, numbers, and hyphens only',
      });
    }

    if (!image) {
      const groupsRes = await api.get<{ groups: VpsImageGroup[] }>('/api/v1/vps/images/grouped');
      const imageChoices = groupsRes.groups.flatMap(g =>
        g.images.map(img => ({
          name: `${img.label} (${img.default_user})`,
          value: img.id,
        })),
      );
      image = await select({ message: 'Operating system:', choices: imageChoices });
    }

    if (!plan) {
      plan = await select({
        message: 'Plan:',
        choices: [
          { name: 'DD Litcov   — 2 vCPU, 2GB RAM, 40GB   — \u20AC4.49/mo (shared)', value: 'nano_shared' },
          { name: 'DD Maliuc   — 3 vCPU, 4GB RAM, 60GB   — \u20AC7.49/mo (shared)', value: 'micro_shared' },
          { name: 'DD Crisan   — 4 vCPU, 8GB RAM, 80GB   — \u20AC12.49/mo (shared)', value: 'small_shared' },
          { name: 'DD Caraorman — 8 vCPU, 16GB RAM, 160GB — \u20AC24.99/mo (shared)', value: 'medium_shared' },
          { name: 'DD Dunavat  — 16 vCPU, 32GB RAM, 320GB — \u20AC49.99/mo (shared)', value: 'large_shared' },
          { name: 'DD Litcov   — 2 vCPU, 2GB RAM, 40GB   — \u20AC8.99/mo (dedicated)', value: 'nano' },
          { name: 'DD Maliuc   — 3 vCPU, 4GB RAM, 80GB   — \u20AC14.99/mo (dedicated)', value: 'micro' },
          { name: 'DD Crisan   — 4 vCPU, 8GB RAM, 160GB  — \u20AC24.99/mo (dedicated)', value: 'small' },
          { name: 'DD Caraorman — 8 vCPU, 16GB RAM, 320GB — \u20AC49.99/mo (dedicated)', value: 'medium' },
          { name: 'DD Dunavat  — 16 vCPU, 32GB RAM, 640GB — \u20AC99.99/mo (dedicated)', value: 'large' },
        ],
      });
    }

    if (!cpuType) {
      cpuType = plan.endsWith('_shared') ? 'shared' : 'dedicated';
    }

    if (!sshKeyId && !pass) {
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
          console.log('');
          console.log(`  Generated password: ${chalk.bold.yellow(pass)}`);
          console.log(chalk.yellow('  Save this password now — it will not be shown again.'));
          console.log('');
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

    const spinner = ora('Creating VPS instance...').start();
    const res = await api.post<{ message: string; instance: VpsInstance }>('/api/v1/vps', body);
    spinner.succeed(`Created VPS ${chalk.bold(res.instance.name)} (${res.instance.id})`);
  });

export const getCommand = new Command('get')
  .description('Show VPS instance details')
  .argument('<id>', 'VPS instance ID')
  .action(async (id: string) => {
    const api = await ApiClient.create();
    const res = await api.get<{ instance: VpsInstance; connection_info: Record<string, unknown>; monthly_cost: number }>(
      `/api/v1/vps/${id}`,
    );
    const v = res.instance;

    const sshCmd = v.public_ip ? `ssh root@${v.public_ip}` : '-';

    const lines = [
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
      ['SSH', sshCmd],
      ['VNC', v.vnc_access_url || '-'],
      ['Cost', `\u20AC${res.monthly_cost ?? v.monthly_cost_dollars}/mo`],
      ['Created', formatDate(v.created_at)],
      ['Deployed', v.deployed_at ? formatDate(v.deployed_at) : '-'],
    ];

    const maxLabel = Math.max(...lines.map(([l]) => l!.length));
    for (const [label, value] of lines) {
      console.log(`${chalk.dim(label!.padEnd(maxLabel))}  ${value}`);
    }
  });

export const updateCommand = new Command('update')
  .description('Update VPS instance (must be stopped)')
  .argument('<id>', 'VPS instance ID')
  .option('--plan <plan>', 'Resource profile')
  .option('--cpu-type <type>', 'CPU allocation: shared or dedicated')
  .option('--cpu-cores <cores>', 'Number of CPU cores')
  .option('--memory <gb>', 'Memory in GB')
  .option('--storage <gb>', 'Storage in GB')
  .option('--snapshots', 'Enable automated snapshots')
  .option('--no-snapshots', 'Disable automated snapshots')
  .action(async (id: string, opts: {
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
    const spinner = ora('Updating VPS instance...').start();

    const res = await api.put<{ message: string; instance: VpsInstance }>(`/api/v1/vps/${id}`, body);
    spinner.succeed(`Updated VPS ${chalk.bold(res.instance.name)}`);
  });

export const deleteCommand = new Command('delete')
  .description('Delete a VPS instance')
  .argument('<id>', 'VPS instance ID')
  .option('--force', 'Skip confirmation')
  .action(async (id: string, opts: { force?: boolean }) => {
    if (!opts.force) {
      const confirmed = await confirm({
        message: `Are you sure you want to delete VPS ${id}? This cannot be undone.`,
        default: false,
      });
      if (!confirmed) {
        console.log('Cancelled.');
        return;
      }
    }

    const api = await ApiClient.create();
    const spinner = ora('Deleting VPS instance...').start();

    await api.delete<{ message: string }>(`/api/v1/vps/${id}`);
    spinner.succeed('VPS instance deleted');
  });
