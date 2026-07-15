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

const { metricsCommand } = await import('../../../src/commands/database/actions.js');

describe('database metrics command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGet.mockReset();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('fetches and prints summary', async () => {
    mockGet
      .mockResolvedValueOnce({ data: [{ id: 'db-1', name: 'my-db' }] })
      .mockResolvedValueOnce({
        summary: {
          memory_used_bytes: 268435456,
          memory_used_mb: 256,
          connected_clients: 12,
          total_queries: 9876,
          slow_queries: 2,
          retrieved_at: '2026-04-19T10:00:00Z',
        },
        health: { is_healthy: true, up_status: true, checked_at: '2026-04-19T10:00:00Z' },
        instance: { id: 'db-1', name: 'my-db' },
      });

    await metricsCommand.parseAsync(['node', 'test', 'db-1']);

    expect(mockGet).toHaveBeenLastCalledWith('/api/v1/database/db-1/metrics');
    const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('256 MB');
    expect(output).toContain('9,876');
    expect(output).toContain('healthy');
  });
});
