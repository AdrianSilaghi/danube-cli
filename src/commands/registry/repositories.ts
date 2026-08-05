import { Command } from 'commander';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client.js';
import { fetchAllPages } from '../../lib/paginate.js';
import { formatTable, formatBytes, formatDate, printDetails } from '../../lib/output.js';
import { isJsonMode, jsonOutput } from '../../lib/json-mode.js';
import { confirmDestruction } from '../../lib/interactive.js';
import { ResourceNotFoundError } from '../../lib/errors.js';

/**
 * Registry repositories and their tags.
 *
 * Read and delete only — there is no create, because a repository comes into
 * existence when something is pushed to it. A `create` here would either lie or
 * invent a local row the registry does not know about.
 *
 * Deletes are stricter than the dashboard's on purpose: the API refuses to
 * remove a local record unless Distribution confirms the manifest is gone,
 * answering 503 with `retryable: true` instead. Reporting that honestly matters
 * more than a tidy success message — the alternative tells someone their image
 * is gone while the bytes, and the quota they consume, remain.
 */

interface RegistryRepository {
  id: string;
  path: string;
  bytes_used?: number | null;
  tag_count?: number | null;
  last_push_at?: string | null;
  created_at: string;
}

interface RegistryTag {
  tag: string;
  digest: string;
  media_type?: string | null;
  bytes_size?: number | null;
  pushed_at?: string | null;
}

const REPOS_PATH = '/api/v1/registry/repositories';

/**
 * Repositories are addressed by path (`tenant/api`) rather than a name field,
 * so the shared resolveResource helper does not fit. An id prefix also works,
 * matching how every other resource behaves.
 */
async function resolveRepository(api: ApiClient, pathOrId: string): Promise<RegistryRepository> {
  const { items } = await fetchAllPages<RegistryRepository>(api, REPOS_PATH);

  const matches = items.filter(
    (r) =>
      r.path === pathOrId || r.id === pathOrId || r.path.endsWith(`/${pathOrId}`) || r.id.startsWith(pathOrId),
  );

  if (matches.length === 0) {
    throw new ResourceNotFoundError(`Repository '${pathOrId}' not found.`);
  }

  if (matches.length > 1) {
    const exact = matches.filter((r) => r.path === pathOrId || r.id === pathOrId);
    if (exact.length === 1) return exact[0]!;

    throw new Error(
      `Ambiguous match '${pathOrId}' — ${matches.length} repositories match:\n` +
        matches.map((r) => `  ${r.path}`).join('\n') +
        '\nUse the full path.',
    );
  }

  return matches[0]!;
}

const lsCommand = new Command('ls')
  .description('List container repositories')
  .action(async () => {
    const api = await ApiClient.create();
    const { items, total, truncated } = await fetchAllPages<RegistryRepository>(api, REPOS_PATH);

    if (isJsonMode()) {
      jsonOutput(items);
      return;
    }

    if (items.length === 0) {
      console.log('No repositories found. They are created by pushing an image.');
      return;
    }

    console.log(
      formatTable(
        ['PATH', 'TAGS', 'SIZE', 'LAST PUSH'],
        items.map((r) => [
          r.path,
          String(r.tag_count ?? 0),
          formatBytes(r.bytes_used ?? 0),
          r.last_push_at ? formatDate(r.last_push_at) : '-',
        ]),
      ),
    );

    if (truncated) {
      console.log(chalk.dim(`Showing ${items.length} of ${total}.`));
    }
  });

const getCommand = new Command('get')
  .description('Show a repository')
  .argument('<path-or-id>', 'Repository path (e.g. my-project/api) or ID')
  .action(async (pathOrId: string) => {
    const api = await ApiClient.create();
    const repo = await resolveRepository(api, pathOrId);
    const detail = await api.get<Record<string, unknown>>(`${REPOS_PATH}/${repo.id}`);

    if (isJsonMode()) {
      jsonOutput(detail);
      return;
    }

    const r = (detail.repository as RegistryRepository | undefined) ?? repo;

    printDetails([
      ['ID', r.id],
      ['Path', r.path],
      ['Tags', String(r.tag_count ?? 0)],
      ['Size', formatBytes(r.bytes_used ?? 0)],
      ['Last push', r.last_push_at ? formatDate(r.last_push_at) : '-'],
      ['Created', formatDate(r.created_at)],
    ]);
  });

const tagsCommand = new Command('tags')
  .description("List a repository's tags")
  .argument('<path-or-id>', 'Repository path or ID')
  .action(async (pathOrId: string) => {
    const api = await ApiClient.create();
    const repo = await resolveRepository(api, pathOrId);
    const res = await api.get<{ data?: RegistryTag[] }>(`${REPOS_PATH}/${repo.id}/tags`);

    if (isJsonMode()) {
      jsonOutput(res);
      return;
    }

    const tags = res.data ?? [];
    if (tags.length === 0) {
      console.log(chalk.dim('No tags in this repository.'));
      return;
    }

    console.log(
      formatTable(
        ['TAG', 'DIGEST', 'SIZE', 'PUSHED'],
        tags.map((t) => [
          t.tag,
          // The digest is the immutable identity: a tag can be moved by a later
          // push, so anything pinning bytes needs this rather than the tag.
          t.digest,
          formatBytes(t.bytes_size ?? 0),
          t.pushed_at ? formatDate(t.pushed_at) : '-',
        ]),
      ),
    );
  });

/**
 * Reports the 503 refusal for what it is. Removing the local record when the
 * registry did not confirm would claim the image is gone while the bytes
 * stayed, and the quota would never come back.
 */
function reportDeleteRefusal(error: unknown): never {
  const status = (error as { status?: number })?.status;
  if (status === 503) {
    console.error(
      chalk.yellow('The registry did not confirm the delete, so nothing was removed. This is retryable.'),
    );
  }
  throw error;
}

const rmTagCommand = new Command('rm-tag')
  .description('Delete a tag from a repository')
  .argument('<path-or-id>', 'Repository path or ID')
  .argument('<tag>', 'Tag to delete')
  .option('--force', 'Skip the confirmation prompt')
  .action(async (pathOrId: string, tag: string, opts: Record<string, boolean>) => {
    const api = await ApiClient.create();
    const repo = await resolveRepository(api, pathOrId);

    const confirmed = await confirmDestruction(
      `${repo.path}:${tag}`,
      `Delete tag '${tag}' from '${repo.path}'?`,
      opts.force,
    );
    if (!confirmed) return;

    try {
      await api.delete(`${REPOS_PATH}/${repo.id}/tags/${encodeURIComponent(tag)}`);
    } catch (error) {
      reportDeleteRefusal(error);
    }

    if (isJsonMode()) {
      jsonOutput({ deleted: true, repository: repo.path, tag });
      return;
    }

    // The repository survives its last tag — removing it is a separate call.
    console.log(chalk.green(`Tag '${tag}' deleted from '${repo.path}'.`));
  });

const rmCommand = new Command('rm')
  .description('Delete a repository and every tag in it')
  .argument('<path-or-id>', 'Repository path or ID')
  .option('--force', 'Skip the confirmation prompt')
  .action(async (pathOrId: string, opts: Record<string, boolean>) => {
    const api = await ApiClient.create();
    const repo = await resolveRepository(api, pathOrId);

    const confirmed = await confirmDestruction(
      repo.path,
      `Delete repository '${repo.path}' and all ${repo.tag_count ?? 0} tag(s)? This cannot be undone.`,
      opts.force,
    );
    if (!confirmed) return;

    try {
      await api.delete(`${REPOS_PATH}/${repo.id}`);
    } catch (error) {
      reportDeleteRefusal(error);
    }

    if (isJsonMode()) {
      jsonOutput({ deleted: true, repository: repo.path });
      return;
    }

    console.log(chalk.green(`Repository '${repo.path}' deleted.`));
  });

export const usageCommand = new Command('usage')
  .description('Show registry storage and repository usage against your limits')
  .action(async () => {
    const api = await ApiClient.create();
    const res = await api.get<{ data: Record<string, number>; meta?: Record<string, unknown> }>(
      '/api/v1/registry/usage',
    );

    if (isJsonMode()) {
      jsonOutput(res);
      return;
    }

    const d = res.data;
    // 0 is the unlimited sentinel, which a caller comparing against it has to
    // know — printing "0" as a limit would read as "no room at all".
    const limitBytes = (value: number) => (value === 0 ? 'unlimited' : formatBytes(value));
    const limitCount = (value: number) => (value === 0 ? 'unlimited' : String(value));

    printDetails([
      ['Storage used', formatBytes(d.bytes_used ?? 0)],
      ['Storage limit', limitBytes(d.max_bytes ?? 0)],
      ['Repositories', String(d.repository_count ?? 0)],
      ['Repository limit', limitCount(d.max_repositories ?? 0)],
    ]);
  });

export const repositoriesCommand = new Command('repos')
  .alias('repositories')
  .description('List and delete container repositories and tags')
  .addCommand(lsCommand)
  .addCommand(getCommand)
  .addCommand(tagsCommand)
  .addCommand(rmTagCommand)
  .addCommand(rmCommand);
