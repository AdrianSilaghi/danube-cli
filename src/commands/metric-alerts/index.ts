import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { fetchAllPages } from '../../lib/paginate.js';
import { resolveResource } from '../../lib/resolve.js';
import { formatTable, statusColor, formatDate, printDetails } from '../../lib/output.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import { confirmDestruction } from '../../lib/interactive.js';
import { UsageError } from '../../lib/errors.js';

/**
 * Metric alerts.
 *
 * No `diagnose` command, and that is not an oversight: the API reports
 * `capabilities.diagnose: false` for alerts, because an alert's history IS its
 * diagnosis. `history` returns each evaluation with the value that was
 * observed, which is strictly more useful than a synthesised verdict about a
 * rule.
 */

interface MetricAlert {
  id: string;
  name?: string | null;
  status: string;
  enabled: boolean;
  resource_type: string;
  resource_id: string;
  resource_name?: string | null;
  metric_type: string;
  metric_label?: string | null;
  metric_unit?: string | null;
  comparison_operator: string;
  comparison_symbol?: string | null;
  threshold_value: number;
  last_metric_value?: number | null;
  duration_minutes?: number | null;
  trigger_count?: number | null;
  last_evaluated_at?: string | null;
  triggered_at?: string | null;
  created_at: string;
}

const LIST_PATH = '/api/v1/metric-alerts';

const OPERATORS = ['gt', 'gte', 'lt', 'lte'] as const;
const CHANNELS = ['database', 'mail', 'webhook'] as const;

function assertOneOf(flag: string, value: string | undefined, allowed: readonly string[]): void {
  if (value !== undefined && !allowed.includes(value)) {
    throw new UsageError(`Invalid --${flag} "${value}". Expected one of: ${allowed.join(', ')}.`);
  }
}

async function resolveAlert(api: ApiClient, nameOrId: string): Promise<MetricAlert> {
  return resolveResource<MetricAlert>(api, LIST_PATH, 'metric alert', nameOrId);
}

const lsCommand = new Command('ls')
  .description('List all metric alerts')
  .action(async () => {
    const api = await ApiClient.create();
    const { items, total, truncated } = await fetchAllPages<MetricAlert>(api, LIST_PATH);

    if (isJsonMode()) {
      jsonOutput(items);
      return;
    }

    if (items.length === 0) {
      console.log('No metric alerts found.');
      return;
    }

    console.log(
      formatTable(
        ['ID', 'NAME', 'STATUS', 'ENABLED', 'RESOURCE', 'CONDITION', 'LAST VALUE', 'CREATED'],
        items.map((a) => [
          a.id,
          a.name ?? '-',
          statusColor(a.status),
          a.enabled ? 'yes' : 'no',
          `${a.resource_type}/${a.resource_name ?? a.resource_id}`,
          `${a.metric_label ?? a.metric_type} ${a.comparison_symbol ?? a.comparison_operator} ${a.threshold_value}${a.metric_unit ?? ''}`,
          a.last_metric_value === null || a.last_metric_value === undefined
            ? '-'
            : `${a.last_metric_value}${a.metric_unit ?? ''}`,
          formatDate(a.created_at),
        ]),
      ),
    );

    if (truncated) {
      console.log(chalk.dim(`Showing ${items.length} of ${total}.`));
    }
  });

/**
 * The metric catalogue is per resource type, and only types with a registered
 * evaluator can actually be alerted on. `meta.alertable` says which — an alert
 * on anything else would store, report `active`, and never fire.
 */
const availableMetricsCommand = new Command('available-metrics')
  .description('List the metrics that can be alerted on for a resource type')
  .argument('<resource-type>', 'Resource type, e.g. vps')
  .action(async (resourceType: string) => {
    const api = await ApiClient.create();
    const res = await api.get<Record<string, unknown>>(
      `${LIST_PATH}/available-metrics/${encodeURIComponent(resourceType)}`,
    );

    if (isJsonMode()) {
      jsonOutput(res);
      return;
    }

    const metrics = (res.data ?? []) as Array<Record<string, unknown>>;
    if (metrics.length === 0) {
      console.log(`No alertable metrics for resource type '${resourceType}'.`);
      return;
    }

    console.log(
      formatTable(
        ['TYPE', 'LABEL', 'UNIT'],
        metrics.map((m) => [String(m.type ?? m.value ?? '-'), String(m.label ?? '-'), String(m.unit ?? '-')]),
      ),
    );

    const meta = res.meta as { alertable?: boolean } | undefined;
    if (meta?.alertable === false) {
      console.log(
        chalk.yellow(
          `\nNo evaluator is registered for '${resourceType}', so an alert on it would never fire.`,
        ),
      );
    }
  });

const createCommand = new Command('create')
  .description('Create a metric alert')
  .requiredOption('--resource-type <type>', 'Resource type (see: danube alerts available-metrics <type>)')
  .requiredOption('--resource-id <id>', 'ID of the resource to watch')
  .requiredOption('--metric <metric>', 'Metric type')
  .requiredOption('--operator <op>', `Comparison: ${OPERATORS.join('|')}`)
  .requiredOption('--threshold <value>', 'Threshold value')
  .option('--duration <minutes>', 'Breach must persist this many minutes (1-60)')
  .option('--name <name>', 'Alert name')
  .option('--description <text>', 'Alert description')
  .option('--channels <list>', `Comma-separated notification channels: ${CHANNELS.join('|')}`)
  .action(async (opts: Record<string, string>) => {
    assertOneOf('operator', opts.operator, OPERATORS);

    const channels = opts.channels?.split(',').map((c) => c.trim()).filter(Boolean);
    channels?.forEach((c) => assertOneOf('channels', c, CHANNELS));

    const threshold = Number(opts.threshold);
    if (Number.isNaN(threshold)) {
      throw new UsageError(`Invalid --threshold "${opts.threshold}". Expected a number.`);
    }

    const body: Record<string, unknown> = {
      resource_type: opts.resourceType,
      resource_id: opts.resourceId,
      metric_type: opts.metric,
      comparison_operator: opts.operator,
      threshold_value: threshold,
    };
    if (opts.duration) body.duration_minutes = Number(opts.duration);
    if (opts.name) body.name = opts.name;
    if (opts.description) body.description = opts.description;
    if (channels?.length) body.notification_channels = channels;

    const api = await ApiClient.create();
    const created = await api.post<Record<string, unknown>>(LIST_PATH, body);

    if (isJsonMode()) {
      jsonOutput(created);
      return;
    }

    console.log(chalk.green('Metric alert created.'));
  });

const getCommand = new Command('get')
  .description('Show a metric alert')
  .argument('<name-or-id>', 'Alert name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const alert = await resolveAlert(api, nameOrId);
    const detail = await api.get<Record<string, unknown>>(`${LIST_PATH}/${alert.id}`);

    if (isJsonMode()) {
      jsonOutput(detail);
      return;
    }

    const a = (detail.data as MetricAlert | undefined) ?? alert;

    printDetails([
      ['ID', a.id],
      ['Name', a.name ?? '-'],
      ['Status', statusColor(a.status)],
      ['Enabled', a.enabled ? 'yes' : 'no'],
      ['Resource', `${a.resource_type}/${a.resource_name ?? a.resource_id}`],
      [
        'Condition',
        `${a.metric_label ?? a.metric_type} ${a.comparison_symbol ?? a.comparison_operator} ${a.threshold_value}${a.metric_unit ?? ''}`,
      ],
      [
        'Last value',
        a.last_metric_value === null || a.last_metric_value === undefined ? '-' : String(a.last_metric_value),
      ],
      ['Duration', a.duration_minutes ? `${a.duration_minutes} min` : '-'],
      ['Times triggered', String(a.trigger_count ?? 0)],
      ['Last evaluated', a.last_evaluated_at ? formatDate(a.last_evaluated_at) : '-'],
      ['Triggered at', a.triggered_at ? formatDate(a.triggered_at) : '-'],
    ]);
  });

const updateCommand = new Command('update')
  .description('Update a metric alert')
  .argument('<name-or-id>', 'Alert name or ID')
  .option('--operator <op>', `Comparison: ${OPERATORS.join('|')}`)
  .option('--threshold <value>', 'Threshold value')
  .option('--duration <minutes>', 'Breach must persist this many minutes (1-60)')
  .option('--name <name>', 'Alert name')
  .option('--description <text>', 'Alert description')
  .option('--channels <list>', `Comma-separated notification channels: ${CHANNELS.join('|')}`)
  .action(async (nameOrId: string, opts: Record<string, string>) => {
    assertOneOf('operator', opts.operator, OPERATORS);

    const body: Record<string, unknown> = {};
    if (opts.operator) body.comparison_operator = opts.operator;
    if (opts.threshold) body.threshold_value = Number(opts.threshold);
    if (opts.duration) body.duration_minutes = Number(opts.duration);
    if (opts.name) body.name = opts.name;
    if (opts.description) body.description = opts.description;
    if (opts.channels) {
      const channels = opts.channels.split(',').map((c) => c.trim()).filter(Boolean);
      channels.forEach((c) => assertOneOf('channels', c, CHANNELS));
      body.notification_channels = channels;
    }

    // An empty PUT is accepted as a no-op, so the caller would believe
    // something changed when nothing did.
    if (Object.keys(body).length === 0) {
      console.error(chalk.yellow('Nothing to update. Pass at least one field.'));
      process.exitCode = 2;
      return;
    }

    const api = await ApiClient.create();
    const alert = await resolveAlert(api, nameOrId);
    const updated = await api.put<Record<string, unknown>>(`${LIST_PATH}/${alert.id}`, body);

    if (isJsonMode()) {
      jsonOutput(updated);
      return;
    }

    console.log(chalk.green('Metric alert updated.'));
  });

const toggleCommand = new Command('toggle')
  .description('Enable or disable a metric alert')
  .argument('<name-or-id>', 'Alert name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const alert = await resolveAlert(api, nameOrId);
    const res = await api.patch<Record<string, unknown>>(`${LIST_PATH}/${alert.id}/toggle`);

    if (isJsonMode()) {
      jsonOutput(res);
      return;
    }

    // Report the state the server says it is in, not the one we assumed it
    // flipped to — a toggle that silently failed would otherwise read as done.
    const data = res.data as { enabled?: boolean } | undefined;
    const state = data?.enabled === undefined ? 'toggled' : data.enabled ? 'enabled' : 'disabled';
    console.log(chalk.green(`Metric alert ${state}.`));
  });

/**
 * An alert's history IS its diagnosis: every evaluation, with the value that
 * was observed. This is the surface a `diagnose` command would have wrapped,
 * which is why the API reports `capabilities.diagnose: false` here.
 */
const historyCommand = new Command('history')
  .description('Show the evaluation history for a metric alert')
  .argument('<name-or-id>', 'Alert name or ID')
  .action(async (nameOrId: string) => {
    const api = await ApiClient.create();
    const alert = await resolveAlert(api, nameOrId);
    const res = await api.get<Record<string, unknown>>(`${LIST_PATH}/${alert.id}/history`);

    if (isJsonMode()) {
      jsonOutput(res);
      return;
    }

    const entries = (res.data ?? []) as Array<Record<string, unknown>>;
    if (entries.length === 0) {
      console.log(chalk.dim('No evaluations recorded yet.'));
      return;
    }

    console.log(
      formatTable(
        ['WHEN', 'STATE', 'VALUE', 'THRESHOLD'],
        entries.map((e) => [
          e.created_at ? formatDate(String(e.created_at)) : '-',
          String(e.state ?? e.status ?? '-'),
          String(e.metric_value ?? '-'),
          String(e.threshold_value ?? '-'),
        ]),
      ),
    );
  });

const rmCommand = new Command('rm')
  .description('Delete a metric alert')
  .argument('<name-or-id>', 'Alert name or ID')
  .option('--force', 'Skip the confirmation prompt')
  .action(async (nameOrId: string, opts: Record<string, boolean>) => {
    const api = await ApiClient.create();
    const alert = await resolveAlert(api, nameOrId);

    const label = alert.name ?? alert.id;
    const confirmed = await confirmDestruction(label, `Delete metric alert '${label}'?`, opts.force);
    if (!confirmed) return;

    await api.delete(`${LIST_PATH}/${alert.id}`);

    if (isJsonMode()) {
      jsonOutput({ deleted: true, id: alert.id });
      return;
    }

    console.log(chalk.green(`Metric alert '${label}' deleted.`));
  });

export const metricAlertsCommand = new Command('metric-alerts')
  .alias('alerts')
  .description('Manage metric alerts')
  .addCommand(lsCommand)
  .addCommand(availableMetricsCommand)
  .addCommand(createCommand)
  .addCommand(getCommand)
  .addCommand(updateCommand)
  .addCommand(toggleCommand)
  .addCommand(historyCommand)
  .addCommand(rmCommand);
