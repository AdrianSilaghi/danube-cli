import type { ApiClient } from './api-client.js';
import { fetchAllPages } from './paginate.js';
import { ResourceNotFoundError } from './errors.js';

export interface ResolvableResource {
  id: string;
  name?: string | null;
  slug?: string | null;
}

function pick<T extends ResolvableResource>(items: T[], total: number, kind: string, nameOrId: string): T {
  const matches = items.filter(
    (r) => r.name === nameOrId || r.slug === nameOrId || r.id === nameOrId || r.id.startsWith(nameOrId),
  );

  if (matches.length === 0) {
    const suffix = total > items.length
      ? ` Note: only ${items.length} of ${total} were searched. Try the full ID.`
      : '';
    throw new ResourceNotFoundError(`${kind} '${nameOrId}' not found.${suffix}`);
  }

  if (matches.length > 1) {
    const exact = matches.filter((r) => r.name === nameOrId || r.slug === nameOrId || r.id === nameOrId);
    if (exact.length === 1) return exact[0]!;

    const candidates = matches.map((r) => `  ${r.id}  ${r.name ?? ''}`).join('\n');
    throw new Error(
      `Ambiguous match '${nameOrId}' — ${matches.length} ${kind}s match:\n${candidates}\nUse a longer prefix or the full name/ID.`,
    );
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
): Promise<T[]> {
  if (refs.some((ref) => !ref.trim())) {
    throw new Error('Empty name or ID given. Provide a resource name, slug, or ID.');
  }

  if (refs.length === 0) return [];

  const { items, total } = await fetchAllPages<T>(api, listPath);

  return refs.map((ref) => pick(items, total, kind, ref));
}

export async function resolveResource<T extends ResolvableResource>(
  api: ApiClient,
  listPath: string,
  kind: string,
  nameOrId: string,
): Promise<T> {
  const [resource] = await resolveResources<T>(api, listPath, kind, [nameOrId]);

  return resource!;
}
