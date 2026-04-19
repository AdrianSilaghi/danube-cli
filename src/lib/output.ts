import chalk from 'chalk';

// Strip ANSI escape codes for width calculation
function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => stripAnsi(r[i] || '').length)),
  );

  const sep = widths.map(w => '-'.repeat(w)).join('  ');
  const headerLine = headers.map((h, i) => h.padEnd(widths[i]!)).join('  ');
  const bodyLines = rows.map(row =>
    row.map((cell, i) => {
      const pad = widths[i]! - stripAnsi(cell).length;
      return cell + ' '.repeat(Math.max(0, pad));
    }).join('  '),
  );

  return [headerLine, sep, ...bodyLines].join('\n');
}

export function statusColor(status: string): string {
  switch (status) {
    case 'live':
    case 'active':
    case 'verified':
    case 'running':
    case 'succeeded':
      return chalk.green(status);
    case 'pending':
    case 'uploading':
    case 'processing':
    case 'deploying':
    case 'starting':
    case 'stopping':
    case 'rebooting':
    case 'reinstalling':
    case 'creating':
    case 'updating':
    case 'destroying':
    case 'building':
    case 'building_image':
    case 'pushing':
    case 'cloning':
      return chalk.yellow(status);
    case 'failed':
    case 'error':
    case 'degraded':
      return chalk.red(status);
    case 'stopped':
      return chalk.dim(status);
    case 'revoked':
      return chalk.red(status);
    default:
      return status;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatRelativeTime(iso: string | null): string {
  if (!iso) return '-';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '-';
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 0) return new Date(iso).toLocaleString();
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.round(diffSec / 3600)}h ago`;
  if (diffSec < 7 * 86_400) return `${Math.round(diffSec / 86_400)}d ago`;
  return new Date(iso).toLocaleString();
}
