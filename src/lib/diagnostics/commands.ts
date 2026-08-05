import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../api-client.js';
import { resolveResource, type ResolvableResource } from '../resolve.js';
import { isJsonMode, jsonEnvelope } from '../json-mode.js';
import { UsageError } from '../errors.js';
// One implementation of each, shared with rapids. A second copy of
// sanitize() would be a security divergence, not a style one.
import { parseSince, sanitize } from '../log-text.js';

/**
 * Command factories for the platform-wide diagnostics surface.
 *
 * Eleven products expose the same three endpoints with the same envelope and
 * the same finding contract, so they get one implementation rather than eleven
 * near-copies that drift. What differs per product is only the noun, the API
 * path, and how a name resolves to an id.
 *
 * These wrap the SERVER-side diagnose: `/diagnose` returns findings the
 * platform has already correlated. That is unlike `rapids diagnose`, which
 * predates the backend engine and still correlates client-side.
 */

export type Severity = 'fatal' | 'action_required' | 'transient_recovered' | 'informational';

export interface Finding {
  code: string;
  severity: Severity;
  summary: string;
  remediation?: string | null;
  retryable?: boolean;
}

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message?: string; retryable?: boolean } | null;
  meta?: Record<string, unknown>;
}

interface DiagnoseData {
  verdict?: string;
  findings?: Finding[];
  status?: Record<string, unknown> | null;
  sections?: Record<string, { available?: boolean; count?: number; truncated?: boolean; sampled_lines?: number }>;
}

interface LogsData {
  available: boolean;
  entries?: Array<Record<string, string>>;
}

interface EventsData {
  available: boolean;
  events?: Array<Record<string, unknown>>;
  truncated?: boolean;
}

export interface ProductTarget {
  /** Singular noun used in help text and messages, e.g. "cache instance". */
  noun: string;
  /** Collection path used to resolve a name or id, e.g. `/api/v1/cache`. */
  listPath: string;
  /** Builds the resource path, e.g. id => `/api/v1/cache/${id}`. */
  resourcePath: (id: string) => string;
  /** Short kind used by resolveResource in its "not found" message. */
  kind: string;
}

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

const SEVERITY_ORDER: Record<Severity, number> = {
  fatal: 0,
  action_required: 1,
  transient_recovered: 2,
  informational: 3,
};

function severityLabel(severity: Severity): string {
  switch (severity) {
    case 'fatal':
      return chalk.red('FATAL');
    case 'action_required':
      return chalk.yellow('ACTION');
    case 'transient_recovered':
      return chalk.dim('RECOVERED');
    default:
      return chalk.dim('INFO');
  }
}

export function renderFindings(findings: Finding[]): void {
  if (findings.length === 0) {
    console.log(chalk.dim('No findings returned.'));
    return;
  }

  const ordered = [...findings].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
  );

  for (const finding of ordered) {
    console.log(`${severityLabel(finding.severity)}  ${chalk.bold(finding.code)}`);
    console.log(`  ${sanitize(finding.summary ?? '')}`);
    if (finding.remediation) console.log(`  ${chalk.dim(sanitize(finding.remediation))}`);
    if (finding.retryable) console.log(chalk.dim('  Retryable — the same request may succeed later.'));
    console.log();
  }
}

/**
 * A section that could not be read is not an empty section. Saying so keeps an
 * operator from concluding "no events" when the truth is "we could not look".
 */
function renderUnavailableSections(sections: DiagnoseData['sections']): void {
  if (!sections) return;

  for (const [name, section] of Object.entries(sections)) {
    if (section?.available === false) {
      console.log(chalk.yellow(`${name}: unavailable — this says nothing about the resource itself.`));
    }
  }
}

export function createDiagnoseCommand(target: ProductTarget): Command {
  return new Command('diagnose')
    .description(`Diagnose a ${target.noun} — ranked findings correlated by the platform`)
    .argument('<name-or-id>', `${target.noun} name or ID`)
    .action(async (nameOrId: string) => {
      const api = await ApiClient.create();
      const resource = await resolveResource<ResolvableResource>(api, target.listPath, target.kind, nameOrId);

      const res = await api.get<Envelope<DiagnoseData>>(`${target.resourcePath(resource.id)}/diagnose`);
      const findings = res.data?.findings ?? [];
      const worst = findings.find((f) => f.severity === 'fatal');

      if (isJsonMode()) {
        // The envelope passes through unchanged. `success` reports the call,
        // not the verdict: a diagnose that finds a fatal problem succeeded at
        // diagnosing. The verdict lives in `data`, and in the exit code.
        jsonEnvelope(res.data, {
          error: res.error ?? null,
          meta: { ...(res.meta ?? {}), finding_count: findings.length },
        });
      } else {
        if (res.data?.verdict) console.log(`Verdict: ${chalk.bold(res.data.verdict)}\n`);
        renderFindings(findings);
        renderUnavailableSections(res.data?.sections);
      }

      if (worst) process.exitCode = 1;
    });
}

export function createLogsCommand(target: ProductTarget): Command {
  return new Command('logs')
    .description(`Fetch logs for a ${target.noun}`)
    .argument('<name-or-id>', `${target.noun} name or ID`)
    .option('--since <duration>', 'Look back this far (e.g. 30m, 6h, 2d)')
    .option('--limit <n>', 'Maximum entries to return')
    .option('--level <level>', `Filter by level (${LEVELS.join('|')})`)
    .option('--cursor <cursor>', 'Resume from a cursor returned by a previous call')
    .action(async (nameOrId: string, opts: Record<string, string>) => {
      if (opts.level !== undefined && !LEVELS.includes(opts.level as (typeof LEVELS)[number])) {
        throw new UsageError(`Invalid --level "${opts.level}". Expected one of: ${LEVELS.join(', ')}.`);
      }

      const api = await ApiClient.create();
      const resource = await resolveResource<ResolvableResource>(api, target.listPath, target.kind, nameOrId);

      const params = new URLSearchParams();
      if (opts.since) params.set('since', parseSince(opts.since));
      if (opts.limit) params.set('limit', opts.limit);
      if (opts.level) params.set('level', opts.level);
      if (opts.cursor) params.set('cursor', opts.cursor);

      const query = params.toString();
      const res = await api.get<Envelope<LogsData>>(
        `${target.resourcePath(resource.id)}/logs${query ? `?${query}` : ''}`,
      );

      if (isJsonMode()) {
        jsonEnvelope(res.data, { error: res.error ?? null, meta: res.meta ?? {} });
        return;
      }

      // available:false is not an empty result — the log store did not answer.
      if (!res.data?.available) {
        console.error(
          chalk.yellow(`Logs are currently unavailable. This says nothing about the ${target.noun} itself.`),
        );
        return;
      }

      const entries = res.data.entries ?? [];
      if (entries.length === 0) {
        console.log(chalk.dim('No log entries in this window. Widen it with --since.'));
        return;
      }

      for (const entry of entries) {
        const level = (entry.level || 'INFO').toUpperCase();
        const colour = level === 'ERROR' ? chalk.red : level === 'WARN' ? chalk.yellow : chalk.dim;
        console.log(
          `${chalk.dim(entry.timestamp ?? '')} ${colour(level.padEnd(5))} ${sanitize(entry.message ?? '')}`,
        );
      }

      const cursor = res.meta?.next_cursor;
      if (typeof cursor === 'string' && cursor !== '') {
        console.log(chalk.dim(`\nMore entries available — resume with --cursor ${cursor}`));
      }
    });
}

export function createEventsCommand(target: ProductTarget): Command {
  return new Command('events')
    .description(`List platform events for a ${target.noun}`)
    .argument('<name-or-id>', `${target.noun} name or ID`)
    .action(async (nameOrId: string) => {
      const api = await ApiClient.create();
      const resource = await resolveResource<ResolvableResource>(api, target.listPath, target.kind, nameOrId);

      const res = await api.get<Envelope<EventsData>>(`${target.resourcePath(resource.id)}/events`);

      if (isJsonMode()) {
        jsonEnvelope(res.data, { error: res.error ?? null, meta: res.meta ?? {} });
        return;
      }

      if (!res.data?.available) {
        console.error(
          chalk.yellow(`Events are currently unavailable. This says nothing about the ${target.noun} itself.`),
        );
        return;
      }

      const events = res.data.events ?? [];
      if (events.length === 0) {
        console.log(chalk.dim('No platform events recorded for this resource.'));
        return;
      }

      for (const event of events) {
        const type = String(event.type ?? 'Normal');
        const colour = type === 'Warning' ? chalk.yellow : chalk.dim;
        console.log(
          `${chalk.dim(String(event.last_seen ?? event.timestamp ?? ''))} ` +
            `${colour(type.padEnd(7))} ${chalk.bold(String(event.reason ?? ''))} ` +
            `${sanitize(String(event.message ?? ''))}`,
        );
      }

      if (res.data.truncated) {
        console.log(chalk.dim('\nOlder events were truncated.'));
      }
    });
}
