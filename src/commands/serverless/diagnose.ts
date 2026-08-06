import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { isJsonMode, jsonEnvelope } from '../../lib/json-mode.js';
import { resolveContainer } from './resolve.js';
import { sanitize, parseSince } from './diagnostics.js';
// One definition of a finding, shared with the ten products already on the
// server-side engine. A second copy here is how the severity domains drift.
import type { Finding } from '../../lib/diagnostics/commands.js';
import type { ServerlessShowResponse, ServerlessStatusDetails } from '../../types/api.js';

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message?: string; retryable?: boolean } | null;
  meta?: Record<string, unknown>;
}

/** The platform's `/diagnose` payload. Findings are already ranked. */
interface DiagnoseData {
  verdict?: string;
  findings?: Finding[];
}

interface RevisionShape {
  name: string | null;
  actual_replicas: number | null;
  desired_replicas: number | null;
  conditions?: Array<{ type: string; status: string; reason: string | null; message: string | null }>;
}
interface RouteShape {
  url: string | null;
  conditions?: Array<{ type: string; status: string; reason: string | null; message: string | null }>;
}
interface LogShape { timestamp: string; level: string; message: string }

interface Report {
  container: { id: string; name: string; url: string | null };
  status: ServerlessStatusDetails | null;
  /** healthy | informational | transient_recovered | action_required | fatal. */
  verdict: string;
  findings: Finding[];
  revisions: { available: boolean; latest: RevisionShape | null; count: number };
  route: RouteShape | null;
  events: { available: boolean; items: unknown[] };
  logs: { available: boolean; entries: LogShape[] };
}

/**
 * One call that answers "why is this not working".
 *
 * An external agent reported reaching a diagnosis took six API calls and manual
 * correlation. The correlation is the hard part and it is always the same, so
 * it belongs in ONE place — and since danubedata#308 that place is the
 * platform, not this file. Every API consumer gets the same conclusions now,
 * not only people who happen to use the CLI.
 *
 * What remains here is the REPORT. `/diagnose` returns findings plus section
 * counts; an operator staring at a broken deploy also wants the revision, the
 * route and the actual error lines, so those reads stay. That is also why this
 * is not another `createDiagnoseCommand` — rapids shows strictly more, and
 * collapsing it into the shared factory would be a regression dressed up as
 * consistency.
 *
 * Every section degrades independently: a diagnosis is still useful when the
 * log backend is down, and "logs unavailable" is very different from "no logs",
 * so the two are never collapsed.
 */
export const diagnoseCommand = new Command('diagnose')
  .description('Aggregate status, revisions, events and logs into one diagnosis')
  .argument('<name-or-id>', 'Container name or ID')
  .option('--since <duration>', 'Log/event window, e.g. 1h', '1h')
  .action(async (nameOrId: string, opts: { since: string }) => {
    const api = await ApiClient.create();
    const container = await resolveContainer(api, nameOrId);
    const id = container.id;
    const since = parseSince(opts.since);

    // Settled, not all-or-nothing: one dead subsystem must not deny the caller
    // the other answers.
    const [showR, diagnoseR, revisionsR, eventsR, logsR] = await Promise.allSettled([
      api.get<ServerlessShowResponse>(`/api/v1/serverless/${id}`),
      api.get<Envelope<DiagnoseData>>(`/api/v1/serverless/${id}/diagnose`),
      api.get<Envelope<Record<string, unknown>>>(`/api/v1/serverless/${id}/revisions`),
      api.get<Envelope<Record<string, unknown>>>(`/api/v1/serverless/${id}/events`),
      api.get<Envelope<Record<string, unknown>>>(
        `/api/v1/serverless/${id}/logs?level=error&limit=20&since=${encodeURIComponent(since)}`,
      ),
    ]);

    const show = showR.status === 'fulfilled' ? showR.value : null;
    const status: ServerlessStatusDetails | null = show?.container.status_details ?? null;

    const section = (r: PromiseSettledResult<Envelope<Record<string, unknown>>>) =>
      r.status === 'fulfilled'
        ? {
            available: (r.value.data as { available?: boolean })?.available ?? true,
            data: r.value.data,
          }
        : { available: false, data: null };

    const revisions = section(revisionsR);
    const events = section(eventsR);
    const logs = section(logsR);

    const revisionList = (revisions.data?.revisions as RevisionShape[] | undefined) ?? [];
    const route = (revisions.data?.route as RouteShape | null | undefined) ?? null;
    const latest = revisionList[0] ?? null;

    const diagnosis = diagnoseR.status === 'fulfilled' ? (diagnoseR.value.data ?? null) : null;
    const findings: Finding[] = [...(diagnosis?.findings ?? [])];

    // An empty findings list because we never asked reads identically to an
    // empty list because nothing is wrong. Say which one this is — the whole
    // point of the exercise is that silence never means "fine".
    if (diagnosis === null) {
      findings.push({
        code: 'serverless.diagnose_unavailable',
        severity: 'informational',
        summary: 'The platform diagnosis could not be fetched, so nothing was correlated. '
          + 'The sections below are raw readings, not a verdict.',
        remediation: 'Retry. Treat the absence of findings here as "not asked", never as "nothing wrong".',
        retryable: true,
      });
    }

    const report: Report = {
      container: { id, name: container.name, url: show?.url ?? null },
      status,
      // The platform's own verdict, not a re-derivation. It knows a ready
      // container whose worst finding is `transient_recovered` is healthy —
      // deriving that here again is exactly how the two would drift apart.
      verdict: diagnosis?.verdict ?? 'unknown',
      findings,
      revisions: { available: revisions.available, latest, count: revisionList.length },
      route,
      events: { available: events.available, items: (events.data?.events as unknown[] | undefined) ?? [] },
      logs: {
        available: logs.available,
        entries: (logs.data?.entries as LogShape[] | undefined) ?? [],
      },
    };

    if (isJsonMode()) {
      // `success` reports the CALL, not the verdict (1.0).
      //
      // This used to set `error` from the worst finding, which made
      // `success: false` — so a diagnosis that worked perfectly and correctly
      // identified a broken container reported itself as a failure. Callers
      // could not tell "we could not diagnose" from "we diagnosed, and the
      // news is bad", and `preflight` already disagreed with it.
      //
      // The verdict lives where every other product puts it: in `data`, and in
      // the exit code, which is still 1 on a fatal finding.
      jsonEnvelope(report, {
        error: null,
        meta: {
          finding_count: findings.length,
          observed_at: status?.observed_at ?? null,
          // Hoisted so a caller reading only `meta` gets the verdict without
          // walking the findings array.
          verdict: report.verdict,
        },
      });
    } else {
      render(report);
    }

    if (findings.some((f) => f.severity === 'fatal')) process.exitCode = 1;
  });

function render(report: Report): void {
  const s = report.status;
  console.log(chalk.bold(report.container.name));
  if (s) {
    console.log(`Status:   ${s.summary}  health=${s.health}  terminal=${s.operation.terminal}${s.stale ? chalk.yellow('  STALE') : ''}`);
    console.log(chalk.dim(`Observed: ${s.observed_at ?? 'unknown'}`));
  }
  if (report.container.url) console.log(`URL:      ${report.container.url}`);

  console.log(`\n${chalk.bold('Findings')}`);
  for (const f of report.findings) {
    const colour = f.severity === 'fatal' ? chalk.red : f.severity === 'action_required' ? chalk.yellow : chalk.dim;
    console.log(`  ${colour(f.severity.padEnd(16))} ${chalk.bold(f.code)}`);
    console.log(`  ${' '.repeat(16)} ${f.summary}`);
    if (f.remediation) console.log(`  ${' '.repeat(16)} ${chalk.cyan(f.remediation)}`);
  }

  if (report.logs.available && report.logs.entries.length > 0) {
    console.log(`\n${chalk.bold('Recent errors')}`);
    for (const e of report.logs.entries.slice(0, 10)) {
      console.log(`  ${chalk.dim(e.timestamp)} ${sanitize(e.message)}`);
    }
  } else if (!report.logs.available) {
    console.log(chalk.dim('\nLogs unavailable — this says nothing about the container.'));
  }
}
