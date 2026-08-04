import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { isJsonMode, jsonEnvelope } from '../../lib/json-mode.js';
import { MissingFlagsError } from '../../lib/errors.js';

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message?: string; retryable?: boolean } | null;
  meta?: Record<string, unknown>;
}

interface Finding {
  code: string;
  severity: string;
  summary: string;
  remediation: string;
  retryable: boolean;
}

interface Preflight {
  image: string;
  registry_host: string | null;
  namespace: string;
  repository: string | null;
  reference: string;
  in_namespace: boolean | null;
  external: boolean;
  credential: { scope: string; keys: number; push_capable: boolean };
  manifest: {
    exists: boolean;
    digest: string | null;
    media_type: string | null;
    size_bytes: number | null;
    architectures: string[];
    reachable: boolean;
    error: string | null;
  };
  quota: Record<string, unknown>;
  can_pull: boolean | null;
  findings: Finding[];
}

const humanBytes = (n: number): string => {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }

  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
};

export const preflightCommand = new Command('preflight')
  .description('Check whether an image can be deployed, before deploying it')
  .option('--image <reference>', 'Full image reference, e.g. cr.danubedata.ro/ns/app:v1')
  .action(async (options: { image?: string }) => {
    if (!options.image) throw new MissingFlagsError(['--image']);

    const api = await ApiClient.create();
    const res = await api.get<Envelope<Preflight>>(
      `/api/v1/registry/preflight?image=${encodeURIComponent(options.image)}`,
    );

    const d = res.data;

    if (isJsonMode()) {
      jsonEnvelope(d, { error: res.error ?? null, meta: res.meta ?? {} });
      // Only a definite no is a failure. `null` means the image lives in a
      // registry we cannot read, which is not evidence of a broken deploy.
      if (d.can_pull === false) process.exitCode = 1;

      return;
    }

    console.log(d.image);
    console.log(`  namespace:  ${d.namespace}${d.in_namespace === false ? chalk.red('  (image is elsewhere)') : ''}`);
    console.log(`  credential: ${d.credential.scope === 'none' ? chalk.red('none') : d.credential.scope}`);

    if (d.external) {
      console.log(chalk.dim('  manifest:   not inspectable — hosted outside DanubeData'));
    } else if (!d.manifest.reachable) {
      console.log(chalk.yellow(`  manifest:   unknown — ${d.manifest.error ?? 'the registry could not be read'}`));
    } else if (!d.manifest.exists) {
      console.log(chalk.red(`  manifest:   not found (${d.reference})`));
    } else {
      console.log(`  manifest:   ${chalk.green('found')} ${d.manifest.digest ?? ''}`);
      console.log(`  platforms:  ${d.manifest.architectures.join(', ') || 'unknown'}`);
      if (d.manifest.size_bytes) console.log(`  size:       ${humanBytes(d.manifest.size_bytes)}`);
    }

    console.log();

    if (d.can_pull === true) {
      console.log(chalk.green('Ready to deploy.'));

      return;
    }

    if (d.can_pull === null) {
      console.log(chalk.dim('Cannot verify — the deploy will attempt the pull itself.'));
    }

    for (const finding of d.findings) {
      const label = finding.severity === 'fatal' ? chalk.red(finding.severity) : chalk.dim(finding.severity);
      console.log(`${label}  ${finding.summary}`);
      console.log(chalk.cyan(`       ${finding.remediation}`));
    }

    if (d.can_pull === false) process.exitCode = 1;
  });
