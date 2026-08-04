import { describe, it, expect, vi } from 'vitest';
import { probe, classifyFailure, COLD_START_THRESHOLD_MS, type DnsResult, type TlsResult } from '../src/lib/probe.js';

const okDns: DnsResult = { resolved: true, address: '203.0.113.10', family: 4, ms: 3, error: null };
const okTls: TlsResult = {
  negotiated: true, protocol: 'TLSv1.3', issuer: "Let's Encrypt",
  valid_to: '2026-11-01T00:00:00.000Z', days_until_expiry: 89, ms: 40, error: null,
};

const dnsImpl = (d: DnsResult = okDns) => vi.fn(async () => d);
const tlsImpl = (t: TlsResult = okTls) => vi.fn(async () => t);

const response = (status: number, headers: Record<string, string> = {}) => ({
  status,
  redirected: false,
  url: '',
  headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  arrayBuffer: async () => new ArrayBuffer(12),
}) as unknown as Response;

describe('probe outcomes', () => {
  it('reports a healthy endpoint as reachable', async () => {
    const report = await probe('https://api.example.com/healthz', {
      fetchImpl: vi.fn(async () => response(200, { 'content-type': 'application/json' })) as unknown as typeof fetch,
      dnsImpl: dnsImpl(), tlsImpl: tlsImpl(),
    });

    expect(report.outcome).toBe('reachable');
    expect(report.ok).toBe(true);
    expect(report.http.status).toBe(200);
    expect(report.http.content_type).toBe('application/json');
    expect(report.http.body_bytes).toBe(12);
  });

  it('separates a failing container from an unreachable one', async () => {
    // A 503 means the URL resolved, TLS worked and something answered. Calling
    // that "unreachable" sends the caller after DNS instead of the container.
    const report = await probe('https://api.example.com/', {
      fetchImpl: vi.fn(async () => response(503)) as unknown as typeof fetch,
      dnsImpl: dnsImpl(), tlsImpl: tlsImpl(),
    });

    expect(report.outcome).toBe('http_error');
    expect(report.ok).toBe(false);
    expect(report.dns.resolved).toBe(true);
    expect(report.tls.negotiated).toBe(true);
    // A 5xx may clear on its own; a 404 will not.
    expect(report.retryable).toBe(true);
  });

  it('does not mark a 404 retryable', async () => {
    const report = await probe('https://api.example.com/', {
      fetchImpl: vi.fn(async () => response(404)) as unknown as typeof fetch,
      dnsImpl: dnsImpl(), tlsImpl: tlsImpl(),
    });

    expect(report.retryable).toBe(false);
  });

  it('honours an expected status', async () => {
    const report = await probe('https://api.example.com/', {
      expectStatus: 204,
      fetchImpl: vi.fn(async () => response(200)) as unknown as typeof fetch,
      dnsImpl: dnsImpl(), tlsImpl: tlsImpl(),
    });

    expect(report.ok).toBe(false);
    expect(report.detail).toContain('Expected 204, got 200');
  });

  it('reports a DNS failure as such, not as a transport error', async () => {
    const failed: DnsResult = { resolved: false, address: null, family: null, ms: 12, error: 'ENOTFOUND' };
    const report = await probe('https://nope.example.com/', {
      fetchImpl: vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }) as unknown as typeof fetch,
      dnsImpl: dnsImpl(failed), tlsImpl: tlsImpl(),
    });

    expect(report.outcome).toBe('dns_failure');
    expect(report.ok).toBe(false);
  });

  it('skips TLS rather than blaming it when the name does not resolve', async () => {
    const failed: DnsResult = { resolved: false, address: null, family: null, ms: 12, error: 'ENOTFOUND' };
    const tls = tlsImpl();
    const report = await probe('https://nope.example.com/', {
      fetchImpl: vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }) as unknown as typeof fetch,
      dnsImpl: dnsImpl(failed), tlsImpl: tls,
    });

    expect(tls).not.toHaveBeenCalled();
    expect(report.tls.negotiated).toBe(null);
    expect(report.tls.error).toContain('did not resolve');
  });

  it('treats plain HTTP as absence of TLS, not as a TLS failure', async () => {
    // Internal Knative URLs are HTTP by design; public TLS terminates at the
    // edge proxy. Reporting that as a failure makes a working deployment look
    // broken.
    const tls = tlsImpl();
    const report = await probe('http://svc.cluster.local/', {
      fetchImpl: vi.fn(async () => response(200)) as unknown as typeof fetch,
      dnsImpl: dnsImpl(), tlsImpl: tls,
    });

    expect(tls).not.toHaveBeenCalled();
    expect(report.tls.negotiated).toBeNull();
    expect(report.tls.error).toBeNull();
    expect(report.ok).toBe(true);
  });

  it('surfaces the upstream service time when the proxy reports it', async () => {
    const report = await probe('https://api.example.com/', {
      fetchImpl: vi.fn(async () => response(200, { 'x-envoy-upstream-service-time': '42' })) as unknown as typeof fetch,
      dnsImpl: dnsImpl(), tlsImpl: tlsImpl(),
    });

    expect(report.http.upstream_ms).toBe(42);
  });

  it('leaves upstream latency null when the header is absent', async () => {
    const report = await probe('https://api.example.com/', {
      fetchImpl: vi.fn(async () => response(200)) as unknown as typeof fetch,
      dnsImpl: dnsImpl(), tlsImpl: tlsImpl(),
    });

    expect(report.http.upstream_ms).toBeNull();
  });
});

describe('warm sampling and cold-start inference', () => {
  it('sends the requested number of follow-up requests', async () => {
    const fetchImpl = vi.fn(async () => response(200));
    const report = await probe('https://api.example.com/', {
      warmRequests: 4,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      dnsImpl: dnsImpl(), tlsImpl: tlsImpl(),
    });

    // One probe plus four warm samples.
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(report.warm?.requests).toBe(4);
  });

  it('declines to guess at a cold start without a warm baseline', async () => {
    // We cannot know whether the container was already running when we
    // arrived, so with nothing to compare against the answer is "unknown".
    const report = await probe('https://api.example.com/', {
      fetchImpl: vi.fn(async () => response(200)) as unknown as typeof fetch,
      dnsImpl: dnsImpl(), tlsImpl: tlsImpl(),
    });

    expect(report.warm).toBeNull();
    expect(report.cold_start_likely).toBeNull();
  });

  it('infers a cold start when the first request far exceeds the warm median', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      // The first request pays the cold start; the rest are warm.
      const delay = call++ === 0 ? COLD_START_THRESHOLD_MS + 200 : 1;
      await new Promise((r) => setTimeout(r, delay));
      return response(200);
    });

    const report = await probe('https://api.example.com/', {
      warmRequests: 3,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      dnsImpl: dnsImpl(), tlsImpl: tlsImpl(),
    });

    expect(report.cold_start_likely).toBe(true);
  });

  it('does not call a uniformly fast endpoint a cold start', async () => {
    const report = await probe('https://api.example.com/', {
      warmRequests: 3,
      fetchImpl: vi.fn(async () => response(200)) as unknown as typeof fetch,
      dnsImpl: dnsImpl(), tlsImpl: tlsImpl(),
    });

    expect(report.cold_start_likely).toBe(false);
  });

  it('counts warm failures without discarding the successful samples', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      if (++call === 3) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      return response(200);
    });

    const report = await probe('https://api.example.com/', {
      warmRequests: 3,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      dnsImpl: dnsImpl(), tlsImpl: tlsImpl(),
    });

    expect(report.warm?.failures).toBe(1);
    expect(report.ok).toBe(true);
  });
});

describe('failure classification', () => {
  it('reads the code from the cause, where Node actually puts it', () => {
    // The top-level error is a generic "fetch failed" TypeError; every useful
    // detail is on `cause`.
    expect(classifyFailure(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })).outcome)
      .toBe('connection_refused');
  });

  it('separates an expired certificate from an unreachable host', () => {
    const result = classifyFailure(Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } }));
    expect(result.outcome).toBe('tls_failure');
    // Issuance is asynchronous — a freshly attached domain clears on its own.
    expect(result.retryable).toBe(true);
  });

  it('treats a permanent NXDOMAIN as not retryable and a lookup timeout as retryable', () => {
    expect(classifyFailure(Object.assign(new TypeError('x'), { cause: { code: 'ENOTFOUND' } })).retryable).toBe(false);
    expect(classifyFailure(Object.assign(new TypeError('x'), { cause: { code: 'EAI_AGAIN' } })).retryable).toBe(true);
  });

  it('classifies an abort as a timeout', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(classifyFailure(err).outcome).toBe('timeout');
  });
});
