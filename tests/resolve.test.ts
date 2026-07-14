import { describe, it, expect, vi } from 'vitest';
import { resolveResource } from '../src/lib/resolve.js';
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

  it('mentions truncation when not everything was searched', async () => {
    const api = apiWith([{ id: 'abc', name: 'x' }], 5000);
    await expect(resolveResource(api, '/api/v1/vps', 'VPS', 'nope')).rejects.toThrow(/of 5000/);
  });
});
