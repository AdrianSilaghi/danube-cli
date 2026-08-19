import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet }),
  },
}));

const { lsCommand } = await import('../../../src/commands/serverless/ls.js');

const makeContainer = (overrides = {}) => ({
  id: 'abc-123', name: 'my-api', slug: 'my-api', deployment_type: 'docker_image',
  source_type: null, image: 'nginx', image_tag: 'latest', port: 8080,
  resource_profile: 'basic', min_scale: 0, max_scale: 10, status: 'running',
  cpu_request: '1000m', cpu_limit: '2000m', memory_request: '512Mi', memory_limit: '1Gi',
  url: 'https://my-api.serverless.danubedata.ro', created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('serverless ls command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGet.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows message when no containers', async () => {
    mockGet.mockResolvedValue({ data: [], pagination: { current_page: 1, last_page: 1, per_page: 15, total: 0 } });

    await lsCommand.parseAsync(['node', 'test']);

    expect(consoleLogSpy).toHaveBeenCalledWith('No serverless containers found.');
  });

  it('displays containers table', async () => {
    mockGet.mockResolvedValue({
      data: [makeContainer(), makeContainer({ name: 'worker', status: 'stopped' })],
      pagination: { current_page: 1, last_page: 1, per_page: 15, total: 2 },
    });

    await lsCommand.parseAsync(['node', 'test']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('NAME'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('my-api'));
  });

  it('shows the request/limit resource columns from the API', async () => {
    mockGet.mockResolvedValue({
      data: [makeContainer()],
      pagination: { current_page: 1, last_page: 1, per_page: 15, total: 1 },
    });

    await lsCommand.parseAsync(['node', 'test']);

    const table = consoleLogSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(table).toContain('CPU');
    expect(table).toContain('MEMORY');
    expect(table).toContain('PROFILE');
    expect(table).toContain('1000m/2000m');
    expect(table).toContain('512Mi/1Gi');
  });

  it('renders dashes when a container is missing the resource fields', async () => {
    // An older platform response without the columns must not crash the table.
    mockGet.mockResolvedValue({
      data: [makeContainer({ cpu_request: undefined, cpu_limit: undefined, memory_request: undefined, memory_limit: undefined })],
      pagination: { current_page: 1, last_page: 1, per_page: 15, total: 1 },
    });

    await lsCommand.parseAsync(['node', 'test']);

    const table = consoleLogSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(table).toContain('-/-');
  });

  it('outputs raw JSON array in json mode', async () => {
    const { setJsonMode } = await import('../../../src/lib/json-mode.js');
    setJsonMode(true);
    mockGet.mockResolvedValue({ data: [makeContainer()], pagination: { current_page: 1, last_page: 1, per_page: 100, total: 1 } });
    await lsCommand.parseAsync(['node', 'test']);
    const printed = consoleLogSpy.mock.calls.at(-1)![0] as string;
    expect(JSON.parse(printed).data[0].name).toBe(makeContainer().name);
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    setJsonMode(false);
  });
});
