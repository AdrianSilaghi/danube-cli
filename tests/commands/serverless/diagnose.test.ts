import { describe, it, expect } from 'vitest';
import { diagnose, classifyEvent, eventFindings, replicaFindings } from '../../../src/commands/serverless/diagnose.js';
import type { ServerlessStatusDetails } from '../../../src/types/api.js';

const status = (over: Partial<ServerlessStatusDetails> = {}): ServerlessStatusDetails => ({
  summary: 'ready',
  health: 'healthy',
  observed_at: '2026-08-04T10:00:00+00:00',
  stale: false,
  operation: { state: 'succeeded', terminal: true },
  error: null,
  ...over,
} as ServerlessStatusDetails);

const codes = (f: ReturnType<typeof diagnose>) => f.map((x) => x.code);

describe('diagnose correlation rules', () => {
  it('reports an in-flight rollout and says nothing else', () => {
    const findings = diagnose(
      status({ summary: 'in_progress', health: 'unknown', operation: { state: 'running', terminal: false } }),
      null, null, true,
    );

    expect(codes(findings)).toEqual(['diagnose.in_progress']);
    // The whole point: unknown health mid-rollout is not a failure.
    expect(findings[0]!.severity).toBe('informational');
  });

  it('does not describe half-built revisions while the rollout is running', () => {
    // A revision mid-rollout legitimately has Ready=Unknown and 0 replicas.
    // Reporting "no pod scheduled" here would be a false alarm on every deploy.
    const findings = diagnose(
      status({ summary: 'in_progress', operation: { state: 'running', terminal: false } }),
      { name: 'x-00002', actual_replicas: 0, desired_replicas: 1, conditions: [{ type: 'Ready', status: 'Unknown', reason: null, message: null }] },
      null, true,
    );

    expect(codes(findings)).not.toContain('diagnose.no_pod_scheduled');
  });

  it('identifies a revision that never scheduled a pod', () => {
    const findings = diagnose(
      status({ summary: 'failed', health: 'unhealthy' }),
      {
        name: 'api-00007',
        actual_replicas: 0,
        desired_replicas: 1,
        conditions: [{ type: 'Ready', status: 'False', reason: 'ContainerMissing', message: 'pull failed' }],
      },
      null, true,
    );

    const f = findings.find((x) => x.code === 'diagnose.no_pod_scheduled')!;
    expect(f).toBeDefined();
    expect(f.severity).toBe('fatal');
    expect(f.retryable).toBe(false);
    // Tells the caller to STOP hunting for logs — the expensive wrong turn.
    expect(f.remediation).toContain('logs will be empty');
    expect(f.remediation).toContain('verify-push');
  });

  it('does not claim no-pod-scheduled when replicas are running', () => {
    const findings = diagnose(
      status({ summary: 'failed' }),
      {
        name: 'api-00007',
        actual_replicas: 1,
        desired_replicas: 1,
        conditions: [{ type: 'Ready', status: 'False', reason: 'CrashLoop', message: null }],
      },
      null, true,
    );

    expect(codes(findings)).not.toContain('diagnose.no_pod_scheduled');
  });

  it('separates deployed-successfully from the URL actually serving', () => {
    const findings = diagnose(
      status(),
      null,
      { url: 'https://x.danubedata.run', conditions: [{ type: 'IngressReady', status: 'False', reason: 'TLSNotEnabled', message: null }] },
      true,
    );

    const f = findings.find((x) => x.code === 'diagnose.ingress_not_ready')!;
    expect(f).toBeDefined();
    expect(f.summary).toContain('TLSNotEnabled');
  });

  it('treats an Unknown ingress as in-progress rather than broken', () => {
    const findings = diagnose(
      status(),
      null,
      { url: null, conditions: [{ type: 'IngressReady', status: 'Unknown', reason: null, message: null }] },
      true,
    );

    const f = findings.find((x) => x.code === 'diagnose.ingress_not_ready')!;
    expect(f.severity).toBe('informational');
    expect(f.retryable).toBe(true);
  });

  it('says the site is UP when degraded, and warns against auto-rollback', () => {
    const findings = diagnose(status({ summary: 'degraded', health: 'degraded' }), null, null, true);

    const f = findings.find((x) => x.code === 'diagnose.degraded_but_serving')!;
    expect(f.severity).toBe('action_required');
    expect(f.summary).toContain('UP');
    expect(f.remediation).toContain('Do not roll back');
  });

  it('surfaces a classified failure with its retryability', () => {
    const findings = diagnose(
      status({
        summary: 'failed',
        error: {
          code: 'serverless.image_pull_auth',
          source: 'reconciler',
          resource: null,
          reason: 'ContainerMissing',
          message: 'The registry rejected the credential.',
          retryable: false,
          observed_at: null,
        },
      }),
      null, null, true,
    );

    const f = findings.find((x) => x.code === 'serverless.image_pull_auth')!;
    expect(f.severity).toBe('fatal');
    expect(f.remediation).toContain('retrying will fail identically');
  });

  it('distinguishes a log-backend outage from silence', () => {
    const findings = diagnose(status(), null, null, false);

    const f = findings.find((x) => x.code === 'diagnose.logs_unavailable')!;
    expect(f.summary).toContain('says nothing about the container');
  });

  it('flags a stale observation', () => {
    const findings = diagnose(status({ stale: true }), null, null, true);
    expect(codes(findings)).toContain('diagnose.stale_observation');
  });

  it('returns nothing when the status alone shows no problem', () => {
    // Deliberately NOT `diagnose.healthy`. Status cannot certify health on its
    // own — the reported defect was "No problems found" printed over unread
    // warning events. The healthy verdict is only reached once event and
    // replica findings have also come back empty.
    expect(codes(diagnose(status(), null, null, true))).toEqual([]);
  });

  it('handles a platform that does not report status_details', () => {
    expect(codes(diagnose(null, null, null, true))).toEqual(['diagnose.status_unavailable']);
  });
});


describe('event classification', () => {
  const ev = (over: Partial<{ type: string; reason: string; message: string }> = {}) => ({
    type: 'Warning', reason: 'SomeReason', message: 'something happened', ...over,
  });

  it('classifies a controller update conflict as recovered, not a fault', () => {
    // The reported case: an agent sees Warning/InternalError and redeploys,
    // turning a self-healing optimistic-lock race into a real incident.
    const s = classifyEvent(
      ev({ reason: 'InternalError', message: 'Operation cannot be fulfilled: the object has been modified' }),
      false,
    );
    expect(s).toBe('transient_recovered');
  });

  it('matches a conflict by message even under an unfamiliar reason', () => {
    expect(classifyEvent(ev({ reason: 'Whatever', message: 'please apply your changes to the latest version' }), false))
      .toBe('transient_recovered');
  });

  it('treats Normal events as informational whatever they say', () => {
    expect(classifyEvent(ev({ type: 'Normal', reason: 'ImagePullBackOff' }), false)).toBe('informational');
  });

  it('calls a hard failure fatal while the container is not healthy', () => {
    expect(classifyEvent(ev({ reason: 'ImagePullBackOff' }), false)).toBe('fatal');
  });

  it('demotes a hard failure the container has since recovered from', () => {
    // A failed pull on an older revision does not make a serving one broken.
    expect(classifyEvent(ev({ reason: 'ImagePullBackOff' }), true)).toBe('transient_recovered');
  });

  it('treats startup readiness noise as recovered once serving', () => {
    expect(classifyEvent(ev({ reason: 'Unhealthy', message: 'readiness probe failed: 503' }), true))
      .toBe('transient_recovered');
    expect(classifyEvent(ev({ reason: 'Unhealthy', message: 'readiness probe failed: 503' }), false))
      .toBe('action_required');
  });

  it('reports recovered warnings instead of staying silent about them', () => {
    // "No problems found" printed over unread warnings was the actual defect.
    const findings = eventFindings(
      [
        ev({ reason: 'InternalError', message: 'the object has been modified' }),
        ev({ reason: 'Unhealthy', message: 'readiness probe failed: 503' }),
      ],
      true,
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]!.code).toBe('diagnose.warnings_recovered');
    expect(findings[0]!.severity).toBe('transient_recovered');
    expect(findings[0]!.remediation).toContain('Redeploying');
  });

  it('surfaces a live warning separately from recovered ones', () => {
    const findings = eventFindings([ev({ reason: 'ImagePullBackOff' })], false);

    expect(findings.some((f) => f.severity === 'fatal')).toBe(true);
  });

  it('says nothing when there are no warnings', () => {
    expect(eventFindings([ev({ type: 'Normal', reason: 'Created' })], true)).toEqual([]);
  });
});

describe('replica disagreement', () => {
  const settled = {
    summary: 'ready', health: 'healthy', observed_at: null, stale: false,
    operation: { state: 'succeeded', terminal: true }, error: null,
  } as never;

  it('explains a cached count that disagrees with the live revision', () => {
    const findings = replicaFindings(
      { current_replicas: 0, metrics_updated_at: '2026-08-04T10:00:00+00:00' },
      { name: 'app-00003', actual_replicas: 1, desired_replicas: 1 },
      settled,
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('informational');
    expect(findings[0]!.remediation).toContain('Trust the revision value');
  });

  it('says nothing when the two agree', () => {
    expect(replicaFindings({ current_replicas: 1 }, { name: 'a', actual_replicas: 1, desired_replicas: 1 }, settled))
      .toEqual([]);
  });

  it('says nothing mid-rollout, when disagreeing is expected', () => {
    const rolling = { ...settled as object, operation: { state: 'running', terminal: false } } as never;
    expect(replicaFindings({ current_replicas: 0 }, { name: 'a', actual_replicas: 1, desired_replicas: 1 }, rolling))
      .toEqual([]);
  });
});
