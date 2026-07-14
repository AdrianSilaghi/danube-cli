import { describe, it, expect, vi } from 'vitest';
import { fetchAllPages } from '../src/lib/paginate.js';
import type { ApiClient } from '../src/lib/api-client.js';

const page = (n: number, lastPage: number, total: number) => ({
  data: [{ id: `item-${n}` }],
  pagination: { current_page: n, last_page: lastPage, per_page: 100, total },
});

describe('fetchAllPages', () => {
  it('walks every page and merges items', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(page(1, 3, 3))
      .mockResolvedValueOnce(page(2, 3, 3))
      .mockResolvedValueOnce(page(3, 3, 3));
    const res = await fetchAllPages({ get } as unknown as ApiClient, '/api/v1/vps');

    expect(res.items).toHaveLength(3);
    expect(res.total).toBe(3);
    expect(res.truncated).toBe(false);
    expect(get).toHaveBeenNthCalledWith(1, '/api/v1/vps?per_page=100&page=1');
    expect(get).toHaveBeenNthCalledWith(3, '/api/v1/vps?per_page=100&page=3');
  });

  it('appends with & when path already has a query string', async () => {
    const get = vi.fn().mockResolvedValueOnce(page(1, 1, 1));
    await fetchAllPages({ get } as unknown as ApiClient, '/api/v1/parameter-groups?type=redis');
    expect(get).toHaveBeenCalledWith('/api/v1/parameter-groups?type=redis&per_page=100&page=1');
  });

  it('tolerates responses without a pagination object', async () => {
    const get = vi.fn().mockResolvedValueOnce({ data: [{ id: 'a' }] });
    const res = await fetchAllPages({ get } as unknown as ApiClient, '/api/v1/vps');
    expect(res.items).toHaveLength(1);
    expect(res.truncated).toBe(false);
  });

  it('stops at MAX_PAGES and reports truncation', async () => {
    const get = vi.fn().mockImplementation((p: string) => {
      const n = Number(new URLSearchParams(p.split('?')[1]).get('page'));
      return Promise.resolve(page(n, 50, 50));
    });
    const res = await fetchAllPages({ get } as unknown as ApiClient, '/api/v1/vps');
    expect(get).toHaveBeenCalledTimes(20);
    expect(res.truncated).toBe(true);
  });
});
