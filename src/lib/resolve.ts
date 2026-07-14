import type { ApiClient } from './api-client.js';
import { fetchAllPages } from './paginate.js';
import { ResourceNotFoundError } from './errors.js';

export interface ResolvableResource {
  id: string;
  name?: string | null;
  slug?: string | null;
}

export async function resolveResource<T extends ResolvableResource>(
  api: ApiClient,
  listPath: string,
  kind: string,
  nameOrId: string,
): Promise<T> {
  if (!nameOrId.trim()) {
    throw new Error('Empty name or ID given. Provide a resource name, slug, or ID.');
  }

  const { items, total } = await fetchAllPages<T>(api, listPath);

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
