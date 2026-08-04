import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { isJsonMode, jsonEnvelope } from '../../lib/json-mode.js';
import { resolveContainer } from './resolve.js';
import { probe, type ProbeReport } from '../../lib/probe.js';

const DEFAULT_TIMEOUT_MS = 15_000;
/** Enough samples for a median that one slow request cannot dominate. */
const DEFAULT_COLD_WARM_REQUESTS = 5;
const CERT_EXPIRY_WARNING_DAYS = 14;

interface ProbeOptions {
  url?: string;
  path: string;
  method: string;
  timeout: string;
  cold?: boolean;
  warmRequests?: string;
  expectStatus?: string;
}

function printHuman(report: ProbeReport): void {
  const { dns, tls, http } = report;

  console.log(chalk.dim(report.url));

  console.log(dns.resolved
    ? `DNS   ${chalk.green('ok')}   ${dns.address} in ${dns.ms}ms`
    : `DNS   ${chalk.red('failed')}   ${dns.error}`);

  if (tls.negotiated === null) {
    // Said out loud because a plain-HTTP internal URL is routinely mistaken
    // for a broken deployment.
    console.log(`TLS   ${chalk.dim('n/a')}  plain HTTP — public TLS terminates at the edge proxy, not in the container`);
  } else if (tls.negotiated) {
    const expiry = tls.days_until_expiry;
    const note = expiry !== null && expiry < CERT_EXPIRY_WARNING_DAYS
      ? chalk.yellow(`  expires in ${expiry}d`)
      : '';
    console.log(`TLS   ${chalk.green('ok')}   ${tls.protocol}, ${tls.issuer ?? 'unknown issuer'} in ${tls.ms}ms${note}`);
  } else {
    console.log(`TLS   ${chalk.red('failed')}   ${tls.error}`);
  }

  if (http.status === null) {
    console.log(`HTTP  ${chalk.red(report.outcome)} after ${report.first_request_ms}ms`);
    if (report.detail) console.log(`      ${report.detail}`);
  } else {
    const colour = report.ok ? chalk.green : chalk.red;
    console.log(`HTTP  ${colour(String(http.status))}   ${http.ms}ms${http.upstream_ms !== null ? ` (container ${http.upstream_ms}ms)` : ''}`);
    if (http.redirected) console.log(chalk.dim(`      redirected to ${http.final_url}`));
    if (http.content_type) console.log(chalk.dim(`      ${http.content_type}, ${http.body_bytes} bytes`));
    if (report.detail) console.log(`      ${report.detail}`);
  }

  if (report.warm) {
    const w = report.warm;
    console.log(`Warm  ${w.min_ms}/${w.median_ms}/${w.max_ms}ms min/median/max over ${w.requests}${w.failures ? chalk.yellow(`, ${w.failures} failed`) : ''}`);
  }

  if (report.cold_start_likely === true) {
    console.log(chalk.dim(`First request paid ~${report.first_request_ms - report.warm!.median_ms}ms more than the warm median — consistent with a cold start.`));
  }
}

export const probeCommand = new Command('probe')
  .description('Check the public URL from outside the platform')
  .argument('[name]', 'Container name, slug, or id')
  .option('--url <url>', 'Probe this URL instead of the container\'s own')
  .option('--path <path>', 'Request this path on the container URL', '/')
  .option('--method <method>', 'HTTP method', 'GET')
  .option('--timeout <ms>', 'Give up on each request after this many milliseconds', String(DEFAULT_TIMEOUT_MS))
  .option('--cold', 'Compare the first request against warm ones to detect a cold start')
  .option('--warm-requests <n>', 'Send this many follow-up requests to measure warm latency')
  .option('--expect-status <code>', 'Treat only this status as success')
  .action(async (name: string | undefined, options: ProbeOptions) => {
    const timeoutMs = Number.parseInt(options.timeout, 10);
    // `--cold` is meaningless without a warm baseline to compare against, so
    // it implies a default sample count rather than silently doing nothing.
    const warmRequests = options.warmRequests !== undefined
      ? Number.parseInt(options.warmRequests, 10)
      : options.cold ? DEFAULT_COLD_WARM_REQUESTS : 0;
    const expectStatus = options.expectStatus ? Number.parseInt(options.expectStatus, 10) : null;

    let target = options.url;

    if (!target) {
      const api = await ApiClient.create();
      const container = await resolveContainer(api, name ?? '');
      const res = await api.get<{ url: string | null }>(`/api/v1/serverless/${container.id}`);

      if (!res.url) {
        // Saying so beats probing an invented hostname and reporting a DNS
        // failure the caller would then chase.
        const error = {
          code: 'serverless.no_public_url',
          message: 'This container has no public URL yet.',
          retryable: true,
        };

        if (isJsonMode()) jsonEnvelope(null, { error });
        else console.error(chalk.yellow(error.message));

        process.exitCode = 1;
        return;
      }

      target = new URL(options.path, res.url).toString();
    }

    const report = await probe(target, {
      method: options.method,
      timeoutMs,
      warmRequests,
      expectStatus,
    });

    if (isJsonMode()) {
      jsonEnvelope(report, {
        meta: {
          timeout_ms: timeoutMs,
          method: options.method,
          warm_requests: warmRequests,
          // Stated rather than implied: we cannot force a scale-to-zero, so a
          // "cold" measurement is an inference, not a guarantee.
          cold_start_forced: false,
        },
      });
    } else {
      printHuman(report);
    }

    // The probe itself succeeded; the target failed. A pipeline still branches.
    if (!report.ok) process.exitCode = 1;
  });
