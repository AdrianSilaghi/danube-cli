import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError } from '../../../src/lib/errors.js';

const mockGet = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet }),
  },
}));

const { metricsCommand } = await import('../../../src/commands/serverless/metrics.js');

const makeContainer = (overrides = {}) => ({
  id: 'abc-123', name: 'mtnai-prod', slug: 'mtnai-prod', deployment_type: 'docker_image',
  source_type: null, image: 'nginx', image_tag: 'latest', port: 8080,
  resource_profile: 'medium', min_scale: 0, max_scale: 10, status: 'running',
  url: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

const listResponse = {
  data: [makeContainer()],
  pagination: { current_page: 1, last_page: 1, per_page: 100, total: 1 },
};

const fullMetricsResponse = {
  container: { id: 'abc-123', name: 'mtnai-prod', status: 'running', resource_profile: 'medium' },
  resources: { cpu_request: '1000m', cpu_limit: '2000m', memory_request: '512Mi', memory_limit: '1Gi' },
  period_hours: 24,
  metrics: {
    requests: { timestamps: ['Aug 19 05:00', 'Aug 19 06:00'], values: [12, 16] },
    latency: { timestamps: ['Aug 19 05:00'], values: [123.45] },
    replicas: { timestamps: ['Aug 19 05:00'], values: [2] },
    cpu: { timestamps: ['Aug 19 05:00', 'Aug 19 06:00'], values: [0.25, 0.75] },
    memory: { timestamps: ['Aug 19 05:00'], values: [268435456] },
    errors: { timestamps: ['Aug 19 05:00'], values: [0.1] },
  },
  current: { current_pods: 2, current_cpu: 0.25, current_memory: 268435456, request_count_5m: 42 },
};

describe('serverless metrics command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGet.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const allOutput = () => consoleLogSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');

  it('renders header, allocation, live usage and series summaries', async () => {
    mockGet.mockResolvedValueOnce(listResponse).mockResolvedValueOnce(fullMetricsResponse);

    await metricsCommand.parseAsync(['node', 'test', 'mtnai-prod']);

    const output = allOutput();
    expect(output).toContain('mtnai-prod');
    expect(output).toContain('(medium, running)');
    expect(output).toContain('last 24h');
    expect(output).toContain('cpu 1000m–2000m · memory 512Mi–1Gi');
    expect(output).toContain('2 pods · 250m cpu · 256 MiB memory · 42 req/5m');
    // Series table: avg/max/latest with per-series units.
    expect(output).toContain('SERIES');
    expect(output).toMatch(/requests\s+14 req\/s\s+16 req\/s\s+16 req\/s/);
    expect(output).toMatch(/cpu\s+500m\s+750m\s+750m/);
    expect(output).toMatch(/memory\s+256 MiB/);
    expect(output).toMatch(/errors\s+0\.1%/);
  });

  it('passes a validated --hours through to the query', async () => {
    mockGet.mockResolvedValueOnce(listResponse).mockResolvedValueOnce({ ...fullMetricsResponse, period_hours: 6 });

    await metricsCommand.parseAsync(['node', 'test', 'mtnai-prod', '--hours', '6']);

    expect(mockGet).toHaveBeenCalledWith('/api/v1/serverless/abc-123/metrics?hours=6');
    expect(allOutput()).toContain('last 6h');
  });

  it.each(['0', '721', '1.5', 'abc'])('rejects --hours %s before making any request', async (bad) => {
    await expect(
      metricsCommand.parseAsync(['node', 'test', 'mtnai-prod', '--hours', bad]),
    ).rejects.toThrow(/Invalid --hours/);

    expect(mockGet).not.toHaveBeenCalled();
  });

  it('renders "no data" for absent series and skips the live line when current is empty', async () => {
    mockGet.mockResolvedValueOnce(listResponse).mockResolvedValueOnce({
      container: fullMetricsResponse.container,
      resources: fullMetricsResponse.resources,
      period_hours: 24,
      metrics: { cpu: { timestamps: ['Aug 19 05:00'], values: [0.25] } },
      current: {},
    });

    await metricsCommand.parseAsync(['node', 'test', 'mtnai-prod', '--hours', '24']);

    const output = allOutput();
    expect(output).toMatch(/requests\s+no data\s+no data\s+no data/);
    expect(output).toMatch(/memory\s+no data/);
    expect(output).toMatch(/cpu\s+250m/);
    expect(output).not.toContain('Live');
    expect(output).toContain('Allocated');
  });

  it('survives PHP empty-array serialization of metrics and current', async () => {
    // The controller builds both as PHP arrays, so "nothing" arrives as []
    // rather than {}.
    mockGet.mockResolvedValueOnce(listResponse).mockResolvedValueOnce({
      container: fullMetricsResponse.container,
      resources: fullMetricsResponse.resources,
      period_hours: 24,
      metrics: [],
      current: [],
    });

    await metricsCommand.parseAsync(['node', 'test', 'mtnai-prod', '--hours', '24']);

    const output = allOutput();
    expect(output).toMatch(/requests\s+no data/);
    expect(output).toMatch(/errors\s+no data/);
    expect(output).not.toContain('Live');
  });

  it('outputs the API payload verbatim in json mode', async () => {
    const { setJsonMode } = await import('../../../src/lib/json-mode.js');
    setJsonMode(true);
    mockGet.mockResolvedValueOnce(listResponse).mockResolvedValueOnce(fullMetricsResponse);

    await metricsCommand.parseAsync(['node', 'test', 'mtnai-prod', '--hours', '24']);

    const printed = JSON.parse(consoleLogSpy.mock.calls.at(-1)![0] as string);
    expect(printed.success).toBe(true);
    expect(printed.data).toEqual(fullMetricsResponse);
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    setJsonMode(false);
  });

  it('explains a 404 as either a deleted container or an undeployed endpoint, exit 4', async () => {
    const originalExit = process.exit;
    process.exit = vi.fn().mockImplementation((code: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never;

    mockGet
      .mockResolvedValueOnce(listResponse)
      .mockRejectedValueOnce(new ApiError(404, 'Not found'));

    await expect(
      metricsCommand.parseAsync(['node', 'test', 'mtnai-prod', '--hours', '24']),
    ).rejects.toThrow('process.exit(4)');

    const errors = consoleErrorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(errors).toContain('metrics endpoint returned 404');
    expect(errors).toContain('danubedata#409');
    expect(process.exit).toHaveBeenCalledWith(4);

    process.exit = originalExit;
  });

  it('explains a 429 with the shared diagnostics budget, exit 1', async () => {
    const originalExit = process.exit;
    process.exit = vi.fn().mockImplementation((code: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never;

    mockGet
      .mockResolvedValueOnce(listResponse)
      .mockRejectedValueOnce(new ApiError(429, 'Too many requests'));

    await expect(
      metricsCommand.parseAsync(['node', 'test', 'mtnai-prod', '--hours', '24']),
    ).rejects.toThrow('process.exit(1)');

    const errors = consoleErrorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(errors).toContain('60 requests/min per token');
    expect(errors).toContain('15s');

    process.exit = originalExit;
  });
});
