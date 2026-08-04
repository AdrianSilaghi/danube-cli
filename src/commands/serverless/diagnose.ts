import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import { resolveContainer } from './resolve.js';
import { sanitize, parseSince } from './diagnostics.js';
import type { ServerlessShowResponse, ServerlessStatusDetails } from '../../types/api.js';

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message?: string; retryable?: boolean } | null;
  meta?: Record<string, unknown>;
}

export interface Finding {
  /** Stable key. Branch on this. */
  code: string;
  severity: 'fatal' | 'action_required' | 'informational';
  summary: string;
  /** What to actually do. Absent when there is nothing to do. */
  remediation?: string;
  retryable: boolean;
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
 * it belongs here rather than in every caller.
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
    // the other four answers.
    const [showR, revisionsR, eventsR, logsR] = await Promise.allSettled([
      api.get<ServerlessShowResponse>(`/api/v1/serverless/${id}`),
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

    const findings = diagnose(status, latest, route, logs.available);

    const report: Report = {
      container: { id, name: container.name, url: show?.url ?? null },
      status,
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
      jsonOutput(report);
    } else {
      render(report);
    }

    if (findings.some((f) => f.severity === 'fatal')) process.exitCode = 1;
  });

/**
 * The correlation rules. Each encodes a conclusion only reachable by reading
 * two sources at once, which is why callers kept getting them wrong.
 */
export function diagnose(
  status: ServerlessStatusDetails | null,
  latest: RevisionShape | null,
  route: RouteShape | null,
  logsAvailable: boolean,
): Finding[] {
  const out: Finding[] = [];

  if (status === null) {
    return [{
      code: 'diagnose.status_unavailable',
      severity: 'informational',
      summary: 'This platform does not report status_details.',
      retryable: true,
    }];
  }

  // An in-flight rollout is the single most misread state. Say so and stop —
  // everything below would be describing a half-built revision.
  if (!status.operation.terminal) {
    return [{
      code: 'diagnose.in_progress',
      severity: 'informational',
      summary: `Rollout in progress (${status.summary}). health "${status.health}" means not-yet-known, not failed.`,
      remediation: 'Wait for status_details.operation.terminal before judging this deploy.',
      retryable: true,
    }];
  }

  if (status.error) {
    out.push({
      code: status.error.code,
      severity: 'fatal',
      summary: status.error.message ?? status.error.code,
      remediation: status.error.retryable
        ? 'Transient — retry the deploy.'
        : 'Not retryable: retrying will fail identically. Fix the cause first.',
      retryable: status.error.retryable,
    });
  }

  const ready = latest?.conditions?.find((c) => c.type === 'Ready');

  // THE rule. Zero replicas beside a settled Ready=False means the image was
  // never fetched, so no pod ever existed to write a log line. Callers burn
  // enormous time hunting for logs that cannot exist.
  if (ready?.status === 'False' && (latest?.actual_replicas ?? 0) === 0) {
    out.push({
      code: 'diagnose.no_pod_scheduled',
      severity: 'fatal',
      summary: `Revision ${latest?.name ?? '(unknown)'} never scheduled a pod (Ready=False, reason ${ready.reason ?? 'unknown'}, replicas 0).`,
      remediation: 'The image was never pulled — logs will be empty and that is expected. '
        + 'Check the image reference and credential with: danube registry verify-push <repo>',
      retryable: false,
    });
  }

  // Deployed successfully and still 404s. Only visible by reading the Route.
  const ingress = route?.conditions?.find((c) => c.type === 'IngressReady');
  if (ingress && ingress.status !== 'True') {
    out.push({
      code: 'diagnose.ingress_not_ready',
      severity: ingress.status === 'False' ? 'fatal' : 'informational',
      summary: `IngressReady is ${ingress.status}${ingress.reason ? ` (${ingress.reason})` : ''} — the revision can be healthy while the public URL does not serve.`,
      remediation: 'This separates "deployed" from "reachable". Check custom domain and TLS.',
      retryable: ingress.status !== 'False',
    });
  }

  if (status.summary === 'degraded') {
    out.push({
      code: 'diagnose.degraded_but_serving',
      severity: 'action_required',
      summary: 'A new revision failed while an older one keeps serving traffic. The site is UP.',
      remediation: 'Do not roll back automatically. Redeploying the same configuration fails identically.',
      retryable: false,
    });
  }

  if (status.stale) {
    out.push({
      code: 'diagnose.stale_observation',
      severity: 'informational',
      summary: `The platform could not reach a live source; this is the last known state (observed ${status.observed_at ?? 'unknown'}).`,
      retryable: true,
    });
  }

  if (!logsAvailable) {
    out.push({
      code: 'diagnose.logs_unavailable',
      severity: 'informational',
      summary: 'The log backend did not answer. This says nothing about the container.',
      remediation: 'Retry; do not read as "no output".',
      retryable: true,
    });
  }

  if (out.length === 0 && status.summary === 'ready') {
    out.push({ code: 'diagnose.healthy', severity: 'informational', summary: 'No problems found.', retryable: false });
  }

  return out;
}

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
