import { ApiClient } from '../../lib/api-client.js';
import type { PaginatedResponse, ServerlessContainer } from '../../types/api.js';

export async function resolveContainer(
  api: ApiClient,
  nameOrId: string,
): Promise<ServerlessContainer> {
  const res = await api.get<PaginatedResponse<ServerlessContainer>>('/api/v1/serverless?per_page=200');

  const matches = res.data.filter(
    (c) => c.name === nameOrId || c.slug === nameOrId || c.id === nameOrId || c.id.startsWith(nameOrId),
  );

  if (matches.length === 0) {
    const suffix = res.pagination.total > res.data.length
      ? ` Note: only ${res.data.length} of ${res.pagination.total} containers were searched. Try using the full ID.`
      : '';
    throw new Error(`Container '${nameOrId}' not found.${suffix}`);
  }

  if (matches.length > 1) {
    // Exact matches (name/slug/full ID) take priority over prefix matches
    const exact = matches.filter(
      (c) => c.name === nameOrId || c.slug === nameOrId || c.id === nameOrId,
    );
    if (exact.length === 1) return exact[0]!;

    const candidates = matches.map((c) => `  ${c.id}  ${c.name}`).join('\n');
    throw new Error(
      `Ambiguous match '${nameOrId}' — ${matches.length} containers match:\n${candidates}\nUse a longer prefix or the full name/ID.`,
    );
  }

  return matches[0]!;
}
