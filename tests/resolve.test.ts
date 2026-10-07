import { describe, it, expect, vi } from 'vitest';
import { resolveResource, resolveResources } from '../src/lib/resolve.js';
import { ResourceNotFoundError } from '../src/lib/errors.js';
import type { ApiClient } from '../src/lib/api-client.js';

const listOf = (items: unknown[], total = items.length) => ({
  data: items,
  pagination: { current_page: 1, last_page: 1, per_page: 100, total },
});

const apiWith = (items: unknown[], total?: number) =>
  ({ get: vi.fn().mockResolvedValue(listOf(items, total)) }) as unknown as ApiClient;

describe('resolveResource', () => {
  it('matches by exact name', async () => {
    const api = apiWith([{ id: '01ABC', name: 'web' }, { id: '01DEF', name: 'api' }]);
    const hit = await resolveResource(api, '/api/v1/vps', 'VPS', 'web');
    expect(hit.id).toBe('01ABC');
  });

  it('matches by id prefix', async () => {
    const api = apiWith([{ id: '01HXYZ', name: 'web' }]);
    const hit = await resolveResource(api, '/api/v1/vps', 'VPS', '01HX');
    expect(hit.id).toBe('01HXYZ');
  });

  it('prefers exact matches over prefix matches', async () => {
    const api = apiWith([{ id: 'abc', name: 'x' }, { id: 'abcdef', name: 'y' }]);
    const hit = await resolveResource(api, '/api/v1/vps', 'VPS', 'abc');
    expect(hit.name).toBe('x');
  });

  it('throws with candidates on ambiguity', async () => {
    const api = apiWith([{ id: 'abc1', name: 'x' }, { id: 'abc2', name: 'y' }]);
    await expect(resolveResource(api, '/api/v1/vps', 'VPS', 'abc')).rejects.toThrow(/Ambiguous/);
  });

  it('lists a candidate that has no name by its id alone', async () => {
    const api = apiWith([{ id: 'abc1', name: null }, { id: 'abc2' }]);

    await expect(resolveResource(api, '/api/v1/vps', 'VPS', 'abc')).rejects.toThrow(/ {2}abc1 {2}\n {2}abc2 {2}\nUse a longer prefix/);
  });

  it('mentions truncation when not everything was searched', async () => {
    const api = apiWith([{ id: 'abc', name: 'x' }], 5000);
    await expect(resolveResource(api, '/api/v1/vps', 'VPS', 'nope')).rejects.toThrow(/of 5000/);
  });

  it('throws ResourceNotFoundError when nothing matches', async () => {
    const api = apiWith([{ id: 'abc', name: 'x' }]);
    await expect(resolveResource(api, '/api/v1/vps', 'VPS', 'nope')).rejects.toThrow(ResourceNotFoundError);
    await expect(resolveResource(api, '/api/v1/vps', 'VPS', 'nope')).rejects.toThrow("VPS 'nope' not found.");
  });

  it('rejects an empty or whitespace-only name/ID without calling the API', async () => {
    const api = apiWith([{ id: 'abc', name: 'x' }]);
    await expect(resolveResource(api, '/api/v1/vps', 'VPS', '')).rejects.toThrow(/Empty name/);
    await expect(resolveResource(api, '/api/v1/vps', 'VPS', '   ')).rejects.toThrow(/Empty name/);
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('resolveResources', () => {
  const buckets = [
    { id: 'b-invoices', name: 'invoices' },
    { id: 'b-logs', name: 'logs' },
    { id: 'b-media', name: 'media' },
  ];

  it('resolves several references against ONE listing, keeping the order asked', async () => {
    const api = apiWith(buckets);

    const hits = await resolveResources(api, '/api/v1/storage/buckets', 'bucket', ['media', 'b-invoices', 'logs']);

    expect(hits.map((h) => h.id)).toEqual(['b-media', 'b-invoices', 'b-logs']);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('names the reference that matches nothing, and resolves nothing', async () => {
    const api = apiWith(buckets);

    await expect(resolveResources(api, '/api/v1/storage/buckets', 'bucket', ['logs', 'nope']))
      .rejects.toThrow("bucket 'nope' not found.");
  });

  it('applies the same rules as resolveResource: ambiguity is an error naming the candidates', async () => {
    const api = apiWith([{ id: 'abc1', name: 'x' }, { id: 'abc2', name: 'y' }]);

    await expect(resolveResources(api, '/api/v1/storage/buckets', 'bucket', ['abc'])).rejects.toThrow(/Ambiguous/);
  });

  it('refuses an empty reference before it calls the API at all', async () => {
    const api = apiWith(buckets);

    await expect(resolveResources(api, '/api/v1/storage/buckets', 'bucket', ['logs', ' '])).rejects.toThrow(/Empty name/);
    expect(api.get).not.toHaveBeenCalled();
  });

  it('hands back the same bucket twice when it is named twice, leaving that to the caller', async () => {
    const api = apiWith(buckets);

    const hits = await resolveResources(api, '/api/v1/storage/buckets', 'bucket', ['logs', 'b-logs']);

    expect(hits.map((h) => h.id)).toEqual(['b-logs', 'b-logs']);
  });

  it('resolves nothing, and calls nothing, for no references', async () => {
    const api = apiWith(buckets);

    await expect(resolveResources(api, '/api/v1/storage/buckets', 'bucket', [])).resolves.toEqual([]);
    expect(api.get).not.toHaveBeenCalled();
  });
});
