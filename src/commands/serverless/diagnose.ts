import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { isJsonMode, jsonEnvelope } from '../../lib/json-mode.js';
import { resolveContainer } from './resolve.js';
import { sanitize, parseSince } from './diagnostics.js';
import type { ServerlessShowResponse, ServerlessStatusDetails } from '../../types/api.js';

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message?: string; retryable?: boolean } | null;
  meta?: Record<string, unknown>;
}

export type Severity = 'fatal' | 'action_required' | 'transient_recovered' | 'informational';

export interface Finding {
  /** Stable key. Branch on this. */
  code: string;
  severity: Severity;
  summary: string;
  /** What to actually do. Absent when there is nothing to do. */
  remediation?: string;
  retryable: boolean;
}

export interface EventShape {
  type: string | null;
  reason: string | null;
  message: string;
  count?: number;
  last_seen?: string | null;
}

/**
 * Kubernetes reasons that are controller races, not faults.
 *
 * The motivating case: a deployment update conflict is a lost optimistic-lock
 * retry that the controller then wins. It surfaces as `Warning`/`InternalError`
 * and an agent reading raw Kubernetes text can conclude the deploy is broken
 * and redeploy — turning a self-healing race into an actual incident.
 */
const RACE_REASONS = new Set(['InternalError', 'FailedUpdate', 'UpdateConflict']);
const RACE_MESSAGE = /object has been modified|please apply your changes to the latest version|conflict|try again/i;

/** Reasons that never resolve on their own. */
const HARD_REASONS = new Set([
  'Failed', 'FailedCreate', 'FailedScheduling', 'ErrImagePull', 'ImagePullBackOff',
  'CrashLoopBackOff', 'BackOff', 'FailedMount', 'Evicted', 'OOMKilling',
]);

/**
 * Classify one event.
 *
 * `containerSettledHealthy` is what makes `transient_recovered` decidable at
 * all: a warning emitted before a revision that is NOW ready and serving has,
 * by definition, been recovered from. Without that context every past warning
 * looks live forever.
 */
export function classifyEvent(event: EventShape, containerSettledHealthy: boolean): Severity {
  if ((event.type ?? 'Normal') !== 'Warning') return 'informational';

  const reason = event.reason ?? '';

  if (RACE_REASONS.has(reason) || RACE_MESSAGE.test(event.message)) {
    return 'transient_recovered';
  }

  // A hard failure on a container that is now serving was survived — a failed
  // pull on an old revision does not make a healthy one broken.
  if (HARD_REASONS.has(reason)) {
    return containerSettledHealthy ? 'transient_recovered' : 'fatal';
  }

  // Readiness probe noise (503s during startup) is expected while a revision
  // warms up and only matters if it never became ready.
  return containerSettledHealthy ? 'transient_recovered' : 'action_required';
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

    const eventItems = (events.data?.events as EventShape[] | undefined) ?? [];
    const settledHealthy = status?.operation.terminal === true
      && (status.summary === 'ready' || status.health === 'healthy');

    const findings = [
      ...diagnose(status, latest, route, logs.available),
      ...eventFindings(eventItems, settledHealthy),
      ...replicaFindings(show?.container ?? null, latest, status),
    ];

    // Only claim health once the events have been read too — the reported
    // failure was "No problems found" printed over unread warnings.
    if (findings.length === 0 && status?.summary === 'ready') {
      findings.push({
        code: 'diagnose.healthy',
        severity: 'informational',
        summary: 'No problems found.',
        retryable: false,
      });
    }

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
      const worst = findings.find((f) => f.severity === 'fatal');
      jsonEnvelope(report, {
        error: worst ? { code: worst.code, message: worst.summary, retryable: worst.retryable } : null,
        meta: { finding_count: findings.length, observed_at: status?.observed_at ?? null },
      });
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

  return out;
}

/**
 * Fold classified events into findings.
 *
 * Separate from diagnose() because it needs the event list, and because the
 * reported failure was specifically that diagnose said "No problems found"
 * while the raw events held recovered 503s and update conflicts. Silence there
 * is not reassuring — it forces the agent back to reading Kubernetes prose,
 * which is exactly what it must never have to do.
 */
export function eventFindings(events: EventShape[], settledHealthy: boolean): Finding[] {
  const warnings = events.filter((e) => (e.type ?? 'Normal') === 'Warning');
  if (warnings.length === 0) return [];

  const classified = warnings.map((e) => ({ event: e, severity: classifyEvent(e, settledHealthy) }));
  const live = classified.filter((c) => c.severity === 'fatal' || c.severity === 'action_required');
  const recovered = classified.filter((c) => c.severity === 'transient_recovered');

  const out: Finding[] = [];

  if (recovered.length > 0) {
    out.push({
      code: 'diagnose.warnings_recovered',
      severity: 'transient_recovered',
      summary: `${recovered.length} warning event(s) already recovered from: ${summarise(recovered.map((c) => c.event))}.`,
      remediation: 'No action. Redeploying because of these would turn a self-healing race into an outage.',
      retryable: false,
    });
  }

  for (const c of live) {
    out.push({
      code: `diagnose.event_${(c.event.reason ?? 'unknown').toLowerCase()}`,
      severity: c.severity,
      summary: `${c.event.reason ?? 'Warning'}: ${c.event.message}`,
      retryable: c.severity !== 'fatal',
    });
  }

  return out;
}

/**
 * Explain a replica count that disagrees with the live revision.
 *
 * Reported as a data bug; it is not one. `current_replicas` on the container is
 * a CACHE written every five minutes by the usage recorder, while a revision's
 * `actual_replicas` is read live from Knative. For a scale-to-zero container
 * that just woke, disagreeing is the correct behaviour of both — but nothing
 * said so, leaving an agent to decide which number to believe.
 */
export function replicaFindings(
  container: { current_replicas?: number; metrics_updated_at?: string | null } | null,
  latest: RevisionShape | null,
  status: ServerlessStatusDetails | null,
): Finding[] {
  if (container == null || latest?.actual_replicas == null) return [];
  if (status?.operation.terminal !== true) return [];

  const cached = container.current_replicas ?? 0;
  if (cached === latest.actual_replicas) return [];

  return [{
    code: 'diagnose.replica_count_lagging',
    severity: 'informational',
    summary: `container.current_replicas is ${cached} but revision ${latest.name ?? '?'} reports ${latest.actual_replicas}.`
      + ` The container figure is a cache refreshed every 5 minutes${container.metrics_updated_at ? ` (last ${container.metrics_updated_at})` : ''}.`,
    remediation: 'Trust the revision value; it is read live. The two legitimately differ after a scale-to-zero wake.',
    retryable: false,
  }];
}

function summarise(events: EventShape[]): string {
  const reasons = [...new Set(events.map((e) => e.reason ?? 'Warning'))];

  return reasons.slice(0, 4).join(', ') + (reasons.length > 4 ? ', …' : '');
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
