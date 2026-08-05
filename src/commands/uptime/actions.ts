import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client.js';
import { resolveResource } from '../../lib/resolve.js';
import { formatTable, formatDate } from '../../lib/output.js';
import { isJsonMode, jsonOutput, jsonEnvelope } from '../../lib/json-mode.js';
import { BASE, checkStatus } from './checks.js';
import type { UptimeCheck, UptimeCheckResponse } from '../../types/api.js';

interface Finding {
  code: string;
  severity: 'fatal' | 'action_required' | 'transient_recovered' | 'informational';
  summary: string;
  remediation: string | null;
  retryable: boolean;
}

interface DiagnoseData {
  verdict: string;
  findings: Finding[];
  status: Record<string, unknown>;
  sections: Record<string, unknown>;
}

const SEVERITY_COLOR: Record<Finding['severity'], (s: string) => string> = {
  fatal: chalk.red,
  action_required: chalk.yellow,
  transient_recovered: chalk.blue,
  informational: chalk.dim,
};

export const pauseCommand = new Command('pause')
  .description('Pause an uptime check')
  .argument('<name-or-id>', 'Check name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const check = await resolveResource<UptimeCheck>(api, BASE, 'uptime check', nameOrId);

    // The endpoint is a toggle, so calling it on an already-paused check
    // would silently RESUME it. Refuse rather than do the opposite of what
    // was asked.
    if (!check.enabled) {
      console.error(chalk.yellow(`Uptime check ${check.name} is already paused.`));
      process.exit(1);
    }

    const spinner = isJsonMode() ? null : ora('Pausing uptime check...').start();
    const res = await api.patch<UptimeCheckResponse>(`${BASE}/${check.id}/toggle`, {});

    if (isJsonMode()) {
      jsonOutput(res.check);
      return;
    }
    spinner!.succeed(`Paused ${chalk.bold(res.check.name)} — no further probes, and any open outage was closed.`);
  });

export const resumeCommand = new Command('resume')
  .description('Resume a paused uptime check')
  .argument('<name-or-id>', 'Check name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const check = await resolveResource<UptimeCheck>(api, BASE, 'uptime check', nameOrId);

    if (check.enabled) {
      console.error(chalk.yellow(`Uptime check ${check.name} is already running.`));
      process.exit(1);
    }

    const spinner = isJsonMode() ? null : ora('Resuming uptime check...').start();
    const res = await api.patch<UptimeCheckResponse>(`${BASE}/${check.id}/toggle`, {});

    if (isJsonMode()) {
      jsonOutput(res.check);
      return;
    }
    spinner!.succeed(`Resumed ${chalk.bold(res.check.name)} — first probe runs immediately.`);
  });

export const incidentsCommand = new Command('incidents')
  .description('List outage history for a check')
  .argument('<name-or-id>', 'Check name or ID')
  .option('--limit <n>', 'Maximum incidents to return', '50')
  .action(async (nameOrId: string, opts: { limit: string }) => {
    const api = await ApiClient.create();
    const check = await resolveResource<UptimeCheck>(api, BASE, 'uptime check', nameOrId);
    const res = await api.get<{ data: Array<Record<string, unknown>> }>(
      `${BASE}/${check.id}/incidents?limit=${encodeURIComponent(opts.limit)}`,
    );

    if (isJsonMode()) {
      jsonOutput(res.data);
      return;
    }

    if (res.data.length === 0) {
      console.log(`No outages recorded for ${check.name}.`);
      return;
    }

    const rows = res.data.map(i => [
      i.started_at ? formatDate(String(i.started_at)) : '-',
      i.ended_at ? formatDate(String(i.ended_at)) : chalk.red('ongoing'),
      String(i.first_error ?? '-'),
    ]);

    console.log(formatTable(['STARTED', 'ENDED', 'FIRST ERROR'], rows));
  });

export const diagnoseCommand = new Command('diagnose')
  .description('Diagnose a check and its target')
  .argument('<name-or-id>', 'Check name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const check = await resolveResource<UptimeCheck>(api, BASE, 'uptime check', nameOrId);
    const res = await api.get<{ success: boolean; data: DiagnoseData; meta: Record<string, unknown> }>(
      `${BASE}/${check.id}/diagnose`,
    );

    const fatal = res.data.findings.some(f => f.severity === 'fatal');

    if (isJsonMode()) {
      // `success` mirrors transport, not verdict — the verdict is in the
      // findings and in the exit code.
      jsonEnvelope(res.data, { meta: res.meta });
      if (fatal) process.exit(1);
      return;
    }

    console.log(`${chalk.bold(check.name)} — ${check.url}`);
    console.log(`Check: ${checkStatus(check)}   Verdict: ${res.data.verdict}\n`);

    if (res.data.findings.length === 0) {
      console.log(chalk.green('No findings.'));
      return;
    }

    for (const finding of res.data.findings) {
      const paint = SEVERITY_COLOR[finding.severity] ?? chalk.white;
      console.log(`${paint(`[${finding.severity}]`)} ${chalk.bold(finding.code)}`);
      console.log(`  ${finding.summary}`);
      if (finding.remediation) console.log(chalk.dim(`  → ${finding.remediation}`));
      console.log();
    }

    if (fatal) process.exit(1);
  });
