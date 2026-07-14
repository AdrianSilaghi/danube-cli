import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet }),
  },
}));

vi.mock('ora', () => ({
  default: () => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis() }),
}));

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
}));

const { metricsCommand } = await import('../../../src/commands/cache/actions.js');

describe('cache metrics command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGet.mockReset();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('fetches and prints summary', async () => {
    mockGet
      .mockResolvedValueOnce({ data: [{ id: 'cache-1', name: 'my-cache' }] })
      .mockResolvedValueOnce({
        summary: {
          memory_used_bytes: 134217728,
          memory_used_mb: 128,
          connected_clients: 5,
          total_commands_processed: 9999,
          keyspace_hits: 8500,
          keyspace_misses: 1499,
          hit_ratio_percentage: 85.01,
          retrieved_at: '2026-04-19T10:00:00Z',
        },
        health: { is_healthy: true, up_status: true, redis_up: true, checked_at: '2026-04-19T10:00:00Z' },
        instance: { id: 'cache-1', name: 'my-cache' },
      });

    await metricsCommand.parseAsync(['node', 'test', 'cache-1']);

    expect(mockGet).toHaveBeenLastCalledWith('/api/v1/cache/cache-1/metrics');
    const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('128 MB');
    expect(output).toContain('9,999');
    expect(output).toContain('85.01%');
    expect(output).toContain('healthy');
  });
});
