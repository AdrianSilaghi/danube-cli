import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { isJsonMode, jsonEnvelope } from '../../lib/json-mode.js';
import { repositoriesCommand, usageCommand } from './repositories.js';
import { keysCommand } from './keys.js';
import { loginCommand } from './login.js';
import { checkDockerPush, parseImageReference } from '../../lib/docker-credentials.js';
import type { DockerPushCheck } from '../../lib/docker-credentials.js';

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message?: string; retryable?: boolean; hint?: string } | null;
  meta?: Record<string, unknown>;
}

interface RegistryContext {
  registry_host: string;
  namespace: string;
  push_prefix: string;
  repositories: { used: number; limit: number | null; can_create: boolean };
  storage: { used_bytes: number; limit_bytes: number | null; can_push: boolean };
}

interface VerifyPush {
  repository: string;
  permitted: boolean;
  namespace: string;
  provided_namespace: string;
  push_reference: string | null;
}

/** The server's answer, plus what Docker's own credentials would be allowed to do. */
type VerifyPushResult = VerifyPush & { docker?: DockerPushCheck };

const humanBytes = (n: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
};

const contextCommand = new Command('context')
  .description('Show where this project may push images, and how much room is left')
  .action(async () => {
    const api = await ApiClient.create();
    const res = await api.get<Envelope<RegistryContext>>('/api/v1/registry/context');

    if (isJsonMode()) {
      jsonEnvelope(res.data, { error: res.error ?? null, meta: res.meta ?? {} });
      return;
    }

    const d = res.data;
    console.log(`Registry:  ${d.registry_host}`);
    console.log(`Namespace: ${chalk.cyan(d.namespace)}`);
    // Printed as a complete prefix because deriving it from the project name is
    // exactly the mistake this command exists to prevent.
    console.log(`Push to:   ${chalk.bold(d.push_prefix)}<repo>:<tag>`);
    console.log();

    const repoLimit = d.repositories.limit === null ? 'unlimited' : String(d.repositories.limit);
    console.log(`Repositories: ${d.repositories.used} / ${repoLimit}${d.repositories.can_create ? '' : chalk.yellow('  (at limit)')}`);

    const storeLimit = d.storage.limit_bytes === null ? 'unlimited' : humanBytes(d.storage.limit_bytes);
    console.log(`Storage:      ${humanBytes(d.storage.used_bytes)} / ${storeLimit}${d.storage.can_push ? '' : chalk.yellow('  (full)')}`);
  });

/**
 * What Docker's own login may do with the repository the server just permitted.
 * The server answers for the project; `docker push` presents Docker's stored
 * credentials, which can be missing, expired or pull-only.
 */
async function checkDockerCredentials(api: ApiClient, verdict: VerifyPush): Promise<DockerPushCheck | undefined> {
  const { host, repository } = parseImageReference(verdict.push_reference!);

  let registryHost = host;
  if (registryHost === null) {
    try {
      registryHost = (await api.get<Envelope<RegistryContext>>('/api/v1/registry/context')).data.registry_host;
    } catch {
      return undefined;
    }
  }

  return checkDockerPush(registryHost, repository);
}

const verifyPushCommand = new Command('verify-push')
  .description('Check whether a push would be permitted, before running it, with the credentials Docker will use')
  .argument('<repository>', 'Repository path or full image reference')
  .action(async (repository: string) => {
    const api = await ApiClient.create();
    const res = await api.get<Envelope<VerifyPush>>(
      `/api/v1/registry/verify-push?repository=${encodeURIComponent(repository)}`,
    );

    // Only a permitted push has a reference to check Docker's login against.
    const docker = res.data.permitted && res.data.push_reference ? await checkDockerCredentials(api, res.data) : undefined;
    // A refusal is a failed check, not a failed command invocation — but a
    // script running this in a pipeline needs a non-zero exit to branch on.
    const failed = !res.data.permitted || docker?.can_push === false;

    if (isJsonMode()) {
      const data: VerifyPushResult = docker ? { ...res.data, docker } : res.data;
      jsonEnvelope(data, { error: res.error ?? null, meta: res.meta ?? {} });
      if (failed) process.exitCode = 1;
      return;
    }

    if (res.data.permitted) {
      console.log(chalk.green('Push permitted'));
      console.log(`  ${res.data.push_reference}`);
      if (docker) {
        const color = docker.can_push === true ? chalk.green : docker.can_push === false ? chalk.red : chalk.yellow;
        console.log(color(`  ${docker.message}`));
      }
      if (failed) process.exitCode = 1;
      return;
    }

    console.error(chalk.red(`Push refused: ${res.error?.code ?? 'unknown'}`));
    if (res.error?.message) console.error(`  ${res.error.message}`);
    // The hint carries the corrected reference. It is the actionable half of
    // the answer, so it is never omitted when present.
    if (res.error?.hint) console.error(chalk.cyan(`  ${res.error.hint}`));
    process.exitCode = 1;
  });

export const registryCommand = new Command('registry')
  .description('Container registry discovery, preflight and access keys');

registryCommand.addCommand(contextCommand);
registryCommand.addCommand(verifyPushCommand);
registryCommand.addCommand(loginCommand);
registryCommand.addCommand(repositoriesCommand);
registryCommand.addCommand(usageCommand);
registryCommand.addCommand(keysCommand);
