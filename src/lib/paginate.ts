import type { ApiClient } from './api-client.js';
import type { PaginatedResponse } from '../types/api.js';

const PER_PAGE = 100;
const MAX_PAGES = 20; // 2000 items — plenty for a CLI listing; caller shows a truncation note beyond this

export interface AllPages<T> {
  items: T[];
  total: number;
  truncated: boolean;
}

export async function fetchAllPages<T>(api: ApiClient, path: string): Promise<AllPages<T>> {
  const sep = path.includes('?') ? '&' : '?';
  const items: T[] = [];
  let total = 0;
  let lastPage = 1;
  let page = 1;

  do {
    const res = await api.get<PaginatedResponse<T>>(`${path}${sep}per_page=${PER_PAGE}&page=${page}`);
    items.push(...res.data);
    lastPage = res.pagination?.last_page ?? 1;
    total = res.pagination?.total ?? items.length;
    page++;
  } while (page <= lastPage && page <= MAX_PAGES);

  return { items, total, truncated: items.length < total };
}
