import chalk from 'chalk';

export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => (r[i] || '').length)),
  );

  const sep = widths.map(w => '-'.repeat(w)).join('  ');
  const headerLine = headers.map((h, i) => h.padEnd(widths[i]!)).join('  ');
  const bodyLines = rows.map(row =>
    row.map((cell, i) => cell.padEnd(widths[i]!)).join('  '),
  );

  return [headerLine, sep, ...bodyLines].join('\n');
}

export function statusColor(status: string): string {
  switch (status) {
    case 'live':
    case 'active':
    case 'verified':
      return chalk.green(status);
    case 'pending':
    case 'uploading':
    case 'processing':
    case 'deploying':
      return chalk.yellow(status);
    case 'failed':
      return chalk.red(status);
    default:
      return status;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}
