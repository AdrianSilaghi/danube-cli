import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { confirm, select } from '@inquirer/prompts';
import { ApiClient } from '../../lib/api-client.js';
import { statusColor, formatBytes, formatDate } from '../../lib/output.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import type { VpsStatus, VpsMetrics, VpsImageGroup } from '../../types/api.js';

export const startCommand = new Command('start')
  .description('Start a stopped VPS instance')
  .argument('<id>', 'VPS instance ID')
  .action(async (id: string) => {
    const api = await ApiClient.create();
    const spinner = isJsonMode() ? null : ora('Starting VPS...').start();
    const res = await api.post<{ message: string; status: string }>(`/api/v1/vps/${id}/start`);

    if (isJsonMode()) {
      jsonOutput({ status: res.status, message: res.message, id });
      return;
    }
    spinner!.succeed(res.message);
  });

export const stopCommand = new Command('stop')
  .description('Stop a running VPS instance')
  .argument('<id>', 'VPS instance ID')
  .action(async (id: string) => {
    const api = await ApiClient.create();
    const spinner = isJsonMode() ? null : ora('Stopping VPS...').start();
    const res = await api.post<{ message: string; status: string }>(`/api/v1/vps/${id}/stop`);

    if (isJsonMode()) {
      jsonOutput({ status: res.status, message: res.message, id });
      return;
    }
    spinner!.succeed(res.message);
  });

export const rebootCommand = new Command('reboot')
  .description('Reboot a running VPS instance')
  .argument('<id>', 'VPS instance ID')
  .action(async (id: string) => {
    const api = await ApiClient.create();
    const spinner = isJsonMode() ? null : ora('Rebooting VPS...').start();
    const res = await api.post<{ message: string; status: string }>(`/api/v1/vps/${id}/reboot`);

    if (isJsonMode()) {
      jsonOutput({ status: res.status, message: res.message, id });
      return;
    }
    spinner!.succeed(res.message);
  });

export const reinstallCommand = new Command('reinstall')
  .description('Reinstall OS on a VPS instance (destroys all data)')
  .argument('<id>', 'VPS instance ID')
  .option('--image <image>', 'OS image ID (e.g. ubuntu-24.04)')
  .option('--cloud-init <script>', 'Custom cloud-init script')
  .option('--force', 'Skip confirmation')
  .action(async (id: string, opts: { image?: string; cloudInit?: string; force?: boolean }) => {
    let image = opts.image;

    if (!image) {
      const api = await ApiClient.create();
      const groupsRes = await api.get<{ groups: VpsImageGroup[] }>('/api/v1/vps/images/grouped');
      const imageChoices = groupsRes.groups.flatMap(g =>
        g.images.map(img => ({
          name: `${img.label} (${img.default_user})`,
          value: img.id,
        })),
      );
      image = await select({ message: 'Select new OS:', choices: imageChoices });
    }

    if (!opts.force && !isJsonMode()) {
      const confirmed = await confirm({
        message: `This will DESTROY ALL DATA on VPS ${id} and reinstall with ${image}. Continue?`,
        default: false,
      });
      if (!confirmed) {
        console.log('Cancelled.');
        return;
      }
    }

    const api = await ApiClient.create();
    const body: Record<string, unknown> = { image };
    if (opts.cloudInit) body.custom_cloud_init = opts.cloudInit;

    const spinner = isJsonMode() ? null : ora('Reinstalling VPS...').start();
    const res = await api.post<{ message: string; status: string }>(`/api/v1/vps/${id}/reinstall`, body);

    if (isJsonMode()) {
      jsonOutput({ status: res.status, message: res.message, id, image });
      return;
    }
    spinner!.succeed(res.message);
  });

export const statusCommand = new Command('status')
  .description('Show VPS instance status')
  .argument('<id>', 'VPS instance ID')
  .action(async (id: string) => {
    const api = await ApiClient.create();
    const s = await api.get<VpsStatus>(`/api/v1/vps/${id}/status`);

    if (isJsonMode()) {
      jsonOutput(s);
      return;
    }

    const lines = [
      ['Status', statusColor(s.status)],
      ['Label', s.status_label],
      ['Transitional', s.is_transitional ? chalk.yellow('yes') : 'no'],
      ['Can Start', s.can_be_started ? chalk.green('yes') : 'no'],
      ['Can Stop', s.can_be_stopped ? chalk.green('yes') : 'no'],
      ['Can Reboot', s.can_be_rebooted ? chalk.green('yes') : 'no'],
      ['Can Destroy', s.can_be_destroyed ? chalk.green('yes') : 'no'],
      ['Updated', formatDate(s.updated_at)],
    ];

    const maxLabel = Math.max(...lines.map(([l]) => l!.length));
    for (const [label, value] of lines) {
      console.log(`${chalk.dim(label!.padEnd(maxLabel))}  ${value}`);
    }
  });

export const metricsCommand = new Command('metrics')
  .description('Show VPS instance metrics')
  .argument('<id>', 'VPS instance ID')
  .action(async (id: string) => {
    const api = await ApiClient.create();
    const m = await api.get<VpsMetrics>(`/api/v1/vps/${id}/metrics`);

    if (isJsonMode()) {
      jsonOutput(m);
      return;
    }

    const uptime = formatUptime(m.uptime_seconds);

    const lines = [
      ['CPU Usage', `${m.cpu.usage_percent}% (${m.cpu.cores} cores)`],
      ['Memory', `${m.memory.used_gb}/${m.memory.total_gb} GB (${m.memory.usage_percent}%)`],
      ['Storage', `${m.storage.used_gb}/${m.storage.total_gb} GB (${m.storage.usage_percent}%)`],
      ['Network RX', `${formatBytes(m.network.rx_bytes_per_sec)}/s`],
      ['Network TX', `${formatBytes(m.network.tx_bytes_per_sec)}/s`],
      ['Network', m.network.status],
      ['Uptime', uptime],
    ];

    const maxLabel = Math.max(...lines.map(([l]) => l!.length));
    for (const [label, value] of lines) {
      console.log(`${chalk.dim(label!.padEnd(maxLabel))}  ${value}`);
    }
  });

export const passwordCommand = new Command('password')
  .description('Show SSH password for a VPS instance')
  .argument('<id>', 'VPS instance ID')
  .action(async (id: string) => {
    if (!isJsonMode()) {
      const confirmed = await confirm({
        message: 'This will display the root password in your terminal. Continue?',
        default: false,
      });

      if (!confirmed) {
        console.log('Cancelled.');
        return;
      }
    }

    const api = await ApiClient.create();
    const res = await api.get<{ password: string; username: string; public_ip: string | null }>(
      `/api/v1/vps/${id}/password`,
    );

    if (isJsonMode()) {
      jsonOutput(res);
      return;
    }

    console.log('');
    console.log(`  Username: ${chalk.bold(res.username)}`);
    console.log(`  Password: ${chalk.bold.yellow(res.password)}`);
    if (res.public_ip) {
      console.log(`  SSH:      ${chalk.dim(`ssh ${res.username}@${res.public_ip}`)}`);
    }
    console.log('');
  });

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
