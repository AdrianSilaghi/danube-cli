import { lookup } from 'node:dns/promises';
import { connect as tlsConnect } from 'node:tls';

/** A cold start on a scaled-to-zero container routinely costs several seconds. */
export const COLD_START_THRESHOLD_MS = 1_500;

export type ProbeOutcome =
  | 'reachable'
  | 'http_error'
  | 'timeout'
  | 'dns_failure'
  | 'tls_failure'
  | 'connection_refused'
  | 'unknown_failure';

export interface DnsResult {
  resolved: boolean;
  address: string | null;
  family: number | null;
  ms: number;
  error: string | null;
}

export interface TlsResult {
  /** Null when the URL is plain HTTP — absence of TLS is not a TLS failure. */
  negotiated: boolean | null;
  protocol: string | null;
  issuer: string | null;
  valid_to: string | null;
  days_until_expiry: number | null;
  ms: number | null;
  error: string | null;
}

export interface HttpResult {
  status: number | null;
  ok: boolean;
  ms: number;
  /** Envoy's own view of how long the container took, when it reports it. */
  upstream_ms: number | null;
  content_type: string | null;
  body_bytes: number | null;
  redirected: boolean;
  final_url: string | null;
}

export interface WarmStats {
  requests: number;
  min_ms: number;
  median_ms: number;
  max_ms: number;
  failures: number;
}

export interface ProbeReport {
  url: string;
  outcome: ProbeOutcome;
  ok: boolean;
  retryable: boolean;
  detail: string | null;
  dns: DnsResult;
  tls: TlsResult;
  http: HttpResult;
  first_request_ms: number;
  warm: WarmStats | null;
  /**
   * Whether the first request looks like it paid a cold start. Inferred by
   * comparing it against the warm median — never asserted, because we cannot
   * know whether the container was already running when we arrived.
   */
  cold_start_likely: boolean | null;
}

/**
 * Turn a fetch rejection into an outcome a caller can branch on.
 *
 * Node reports transport failures as a generic TypeError whose `cause` carries
 * the real reason, so the message alone cannot distinguish "the name does not
 * resolve" from "the certificate is bad" — two failures with completely
 * different remedies.
 */
export function classifyFailure(err: unknown): { outcome: ProbeOutcome; retryable: boolean; detail: string } {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? (err as { code?: string })?.code ?? '';
  const detail = cause?.message ?? (err instanceof Error ? err.message : String(err));

  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return { outcome: 'timeout', retryable: true, detail: 'No response before the timeout elapsed.' };
  }

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    // A domain added minutes ago may simply not have propagated yet.
    return { outcome: 'dns_failure', retryable: code === 'EAI_AGAIN', detail };
  }

  if (code.startsWith('ERR_TLS') || code.startsWith('UNABLE_TO_VERIFY') || code === 'CERT_HAS_EXPIRED'
      || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN') {
    // Certificate issuance is asynchronous: a freshly attached custom domain
    // fails this way until the order completes.
    return { outcome: 'tls_failure', retryable: true, detail };
  }

  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
    return { outcome: 'connection_refused', retryable: true, detail };
  }

  return { outcome: 'unknown_failure', retryable: true, detail };
}

export async function resolveDns(hostname: string): Promise<DnsResult> {
  const started = Date.now();

  try {
    const { address, family } = await lookup(hostname);

    return { resolved: true, address, family, ms: Date.now() - started, error: null };
  } catch (err) {
    return {
      resolved: false,
      address: null,
      family: null,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Complete a TLS handshake and read the certificate.
 *
 * Done as its own connection rather than inferred from the HTTP request: a
 * certificate that expires in three days is worth knowing about while the site
 * still answers 200, and an HTTP-only URL must report `negotiated: null` rather
 * than a failure.
 */
export function inspectTls(hostname: string, port: number, timeoutMs: number): Promise<TlsResult> {
  const started = Date.now();

  return new Promise((resolve) => {
    const socket = tlsConnect({ host: hostname, port, servername: hostname, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      const validTo = cert && cert.valid_to ? new Date(cert.valid_to) : null;

      resolve({
        negotiated: true,
        protocol: socket.getProtocol(),
        issuer: cert?.issuer?.O ?? cert?.issuer?.CN ?? null,
        valid_to: validTo ? validTo.toISOString() : null,
        days_until_expiry: validTo ? Math.floor((validTo.getTime() - Date.now()) / 86_400_000) : null,
        ms: Date.now() - started,
        error: null,
      });
      socket.destroy();
    });

    const fail = (message: string) => {
      resolve({
        negotiated: false,
        protocol: null,
        issuer: null,
        valid_to: null,
        days_until_expiry: null,
        ms: Date.now() - started,
        error: message,
      });
      socket.destroy();
    };

    socket.on('error', (err: Error) => fail(err.message));
    socket.on('timeout', () => fail('TLS handshake timed out.'));
  });
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
};

async function request(
  url: string,
  opts: { method: string; timeoutMs: number; fetchImpl: typeof fetch },
): Promise<{ http: HttpResult } | { failure: ReturnType<typeof classifyFailure>; ms: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const started = Date.now();

  try {
    const res = await opts.fetchImpl(url, { method: opts.method, signal: controller.signal, redirect: 'follow' });
    const body = await res.arrayBuffer().catch(() => new ArrayBuffer(0));
    const ms = Date.now() - started;
    const upstream = res.headers.get('x-envoy-upstream-service-time');

    return {
      http: {
        status: res.status,
        // A 5xx is a reachable container that is failing — a different problem
        // from an unreachable one, and never reported as success.
        ok: res.status < 400,
        ms,
        upstream_ms: upstream === null ? null : Number.parseInt(upstream, 10),
        content_type: res.headers.get('content-type'),
        body_bytes: body.byteLength,
        redirected: res.redirected,
        final_url: res.url || url,
      },
    };
  } catch (err) {
    return { failure: classifyFailure(err), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

export interface ProbeOptions {
  method?: string;
  timeoutMs?: number;
  warmRequests?: number;
  expectStatus?: number | null;
  fetchImpl?: typeof fetch;
  /** Injected in tests; production reads the real network. */
  dnsImpl?: typeof resolveDns;
  tlsImpl?: typeof inspectTls;
}

export async function probe(rawUrl: string, options: ProbeOptions = {}): Promise<ProbeReport> {
  const url = new URL(rawUrl);
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? 15_000;
  const warmRequests = options.warmRequests ?? 0;
  const fetchImpl = options.fetchImpl ?? fetch;
  const dnsImpl = options.dnsImpl ?? resolveDns;
  const tlsImpl = options.tlsImpl ?? inspectTls;
  const isHttps = url.protocol === 'https:';

  const dns = await dnsImpl(url.hostname);

  // Both are pointless without a resolvable name, and reporting a TLS error
  // that is really a DNS error sends the caller after the wrong problem.
  const tls: TlsResult = isHttps && dns.resolved
    ? await tlsImpl(url.hostname, Number(url.port) || 443, timeoutMs)
    : {
      // An http:// URL is not a TLS failure. Internal Knative URLs are plain
      // HTTP by design; public TLS terminates at the edge proxy.
      negotiated: null,
      protocol: null,
      issuer: null,
      valid_to: null,
      days_until_expiry: null,
      ms: null,
      error: isHttps && !dns.resolved ? 'Skipped: the hostname did not resolve.' : null,
    };

  const first = await request(rawUrl, { method, timeoutMs, fetchImpl });

  if ('failure' in first) {
    const emptyHttp: HttpResult = {
      status: null, ok: false, ms: first.ms, upstream_ms: null,
      content_type: null, body_bytes: null, redirected: false, final_url: null,
    };

    return {
      url: rawUrl,
      // A DNS failure observed directly is more specific than the fetch's own
      // classification, so it wins.
      outcome: dns.resolved ? first.failure.outcome : 'dns_failure',
      ok: false,
      retryable: first.failure.retryable,
      detail: first.failure.detail,
      dns,
      tls,
      http: emptyHttp,
      first_request_ms: first.ms,
      warm: null,
      cold_start_likely: null,
    };
  }

  const warmSamples: number[] = [];
  let warmFailures = 0;

  for (let i = 0; i < warmRequests; i++) {
    const next = await request(rawUrl, { method, timeoutMs, fetchImpl });
    if ('failure' in next) warmFailures++;
    else warmSamples.push(next.http.ms);
  }

  const warm: WarmStats | null = warmRequests === 0 ? null : {
    requests: warmRequests,
    min_ms: warmSamples.length ? Math.min(...warmSamples) : 0,
    median_ms: warmSamples.length ? median(warmSamples) : 0,
    max_ms: warmSamples.length ? Math.max(...warmSamples) : 0,
    failures: warmFailures,
  };

  const expected = options.expectStatus ?? null;
  const statusMatches = expected === null ? first.http.ok : first.http.status === expected;

  return {
    url: rawUrl,
    outcome: statusMatches ? 'reachable' : 'http_error',
    ok: statusMatches,
    retryable: !statusMatches && (first.http.status ?? 0) >= 500,
    detail: statusMatches
      ? null
      : expected !== null
        ? `Expected ${expected}, got ${first.http.status}.`
        : `The container answered ${first.http.status}.`,
    dns,
    tls,
    http: first.http,
    first_request_ms: first.http.ms,
    warm,
    // Only decidable with a warm baseline to compare against.
    cold_start_likely: warm && warmSamples.length
      ? first.http.ms - warm.median_ms > COLD_START_THRESHOLD_MS
      : null,
  };
}
