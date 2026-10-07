import type { ApiClient } from './api-client.js';
import { fetchAllPages } from './paginate.js';
import { ResourceNotFoundError, UsageError } from './errors.js';

export interface ResolvableResource {
  id: string;
  name?: string | null;
  slug?: string | null;
}

export interface ResolveOptions {
  /**
   * Only an exact name, slug or full id matches; the beginning of an id does not.
   * For commands that decide who may reach something: a name that is not a
   * resource's name must not land on the one whose id happens to start with it
   * (`cafe`, `beef` and `dead` are all hex). Two matches are then a usage error
   * that asks for the id, as an ambiguous access key is.
   */
  exact?: boolean;
}

function pick<T extends ResolvableResource>(
  items: T[],
  total: number,
  kind: string,
  nameOrId: string,
  exact: boolean,
): T {
  const matches = items.filter(
    (r) => r.name === nameOrId || r.slug === nameOrId || r.id === nameOrId || (!exact && r.id.startsWith(nameOrId)),
  );

  if (matches.length === 0) {
    const suffix = total > items.length
      ? ` Note: only ${items.length} of ${total} were searched. Try the full ID.`
      : '';
    throw new ResourceNotFoundError(`${kind} '${nameOrId}' not found.${suffix}`);
  }

  if (matches.length > 1) {
    const exactMatches = matches.filter((r) => r.name === nameOrId || r.slug === nameOrId || r.id === nameOrId);
    if (exactMatches.length === 1) return exactMatches[0]!;

    const candidates = matches.map((r) => `  ${r.id}  ${r.name ?? ''}`).join('\n');
    const list = `Ambiguous match '${nameOrId}' — ${matches.length} ${kind}s match:\n${candidates}\n`;

    if (exact) throw new UsageError(`${list}Use the ${kind}'s id.`);

    throw new Error(`${list}Use a longer prefix or the full name/ID.`);
  }

  return matches[0]!;
}

/**
 * Several references against ONE listing: a command that takes a list of
 * buckets should not read the bucket list once per bucket. The answer keeps the
 * order asked, and naming a resource twice returns it twice — whether that is
 * a mistake is for the caller to say.
 */
export async function resolveResources<T extends ResolvableResource>(
  api: ApiClient,
  listPath: string,
  kind: string,
  refs: string[],
  options: ResolveOptions = {},
): Promise<T[]> {
  if (refs.some((ref) => !ref.trim())) {
    throw new Error('Empty name or ID given. Provide a resource name, slug, or ID.');
  }

  if (refs.length === 0) return [];

  const { items, total } = await fetchAllPages<T>(api, listPath);

  return refs.map((ref) => pick(items, total, kind, ref, options.exact === true));
}

export async function resolveResource<T extends ResolvableResource>(
  api: ApiClient,
  listPath: string,
  kind: string,
  nameOrId: string,
  options: ResolveOptions = {},
): Promise<T> {
  const [resource] = await resolveResources<T>(api, listPath, kind, [nameOrId], options);

  return resource!;
}
