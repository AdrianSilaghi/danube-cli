import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('../../src/lib/api-client.js', () => ({
  ApiClient: { create: () => Promise.resolve({ get: mockGet, post: mockPost }) },
}));

vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  }),
}));

const { queueCommand } = await import('../../src/commands/queue/index.js');
const { javaPropertiesSnippet, kcatSnippet, planProblem } = await import('../../src/commands/queue/kafka.js');
const { setJsonMode } = await import('../../src/lib/json-mode.js');

const run = (args: string[]) => queueCommand.parseAsync(args, { from: 'user' });

const kafkaInfo = {
  provider: 'kafka',
  status: 'ready',
  host: 'kafka-ev-p1.queues.danubedata.ro',
  port: 29092,
  certificate: "The broker's certificate is issued by Let's Encrypt, a publicly trusted authority: clients need no CA file.",
  bootstrap_servers: 'kafka-ev-p1.queues.danubedata.ro:29092',
  security_protocol: 'SASL_SSL',
  sasl_mechanism: 'SCRAM-SHA-512',
  username: 'kafka-ev-admin',
  password: "p'w\"d",
};

describe('queue commands, Kafka provider', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  const out = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGet.mockReset();
    mockPost.mockReset();
    process.exitCode = undefined;
    setJsonMode(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    setJsonMode(false);
  });

  it('creates a Kafka cluster with provider, plan and version', async () => {
    mockPost.mockResolvedValueOnce({ id: 'q-1', name: 'ev', created_at: '2026-01-02T03:04:05Z' });

    await run(['create', '--name', 'ev', '--provider', 'kafka', '--profile', 'kafka-small', '--version=4.3']);

    const [path, body] = mockPost.mock.calls[0] ?? [];
    expect(path).toBe('/api/v1/queue');
    expect(body).toMatchObject({ name: 'ev', provider: 'kafka', resource_profile: 'kafka-small', version: '4.3' });
  });

  it('sends provider rabbitmq by default', async () => {
    mockPost.mockResolvedValueOnce({ id: 'q-1', name: 'ev', created_at: '2026-01-02T03:04:05Z' });

    await run(['create', '--name', 'ev', '--profile', 'small']);

    expect(mockPost.mock.calls[0]?.[1]).toMatchObject({ provider: 'rabbitmq' });
  });

  it('refuses a non-Kafka plan for Kafka before calling the API', async () => {
    await run(['create', '--name', 'ev', '--provider', 'kafka', '--profile', 'small']);

    expect(process.exitCode).toBe(2);
    expect(mockPost).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.join(' ')).toMatch(/kafka-small/);
  });

  it('points a Kafka plan on RabbitMQ at --provider kafka', async () => {
    await run(['create', '--name', 'ev', '--profile', 'kafka-small']);

    expect(process.exitCode).toBe(2);
    expect(mockPost).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.join(' ')).toMatch(/--provider kafka/);
  });

  it('rejects an unknown provider', async () => {
    await run(['create', '--name', 'ev', '--provider', 'nats', '--profile', 'small']);

    expect(process.exitCode).toBe(2);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('filters the list by provider and shows the provider column', async () => {
    mockGet.mockResolvedValueOnce({
      data: [{ id: 'q-1', name: 'ev', status: 'running', provider: 'kafka', created_at: '2026-01-02T03:04:05Z' }],
      pagination: { last_page: 1, total: 1 },
    });

    await run(['ls', '--provider', 'kafka']);

    expect(mockGet.mock.calls[0]?.[0]).toMatch(/^\/api\/v1\/queue\?provider=kafka&per_page=/);
    expect(out()).toContain('PROVIDER');
    expect(out()).toContain('kafka');
  });

  it('rejects an unknown list provider without calling the API', async () => {
    await run(['ls', '--provider', 'nats']);

    expect(process.exitCode).toBe(2);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('prints bootstrap address, SASL settings and ready-to-use snippets', async () => {
    mockGet
      .mockResolvedValueOnce({ data: [{ id: 'q-1', name: 'ev', provider: 'kafka' }], pagination: { last_page: 1, total: 1 } })
      .mockResolvedValueOnce(kafkaInfo);

    await run(['connection-info', 'ev']);

    const text = out();
    expect(text).toContain('kafka-ev-p1.queues.danubedata.ro:29092');
    expect(text).toContain('SCRAM-SHA-512');
    expect(text).toContain('kcat -L -b');
    expect(text).toContain('ScramLoginModule');
    expect(text).toMatch(/no CA file/);
  });

  it('says the endpoint is not ready instead of printing empty snippets', async () => {
    mockGet
      .mockResolvedValueOnce({ data: [{ id: 'q-1', name: 'ev', provider: 'kafka' }], pagination: { last_page: 1, total: 1 } })
      .mockResolvedValueOnce({ provider: 'kafka', status: 'provisioning', bootstrap_servers: null, host: null, port: null, username: 'kafka-ev-admin', password: null });

    await run(['connection-info', 'ev']);

    expect(out()).toMatch(/not ready/);
    expect(out()).toContain('provisioning');
    expect(out()).not.toContain('kcat -L');
  });

  it('leaves the JSON connection info untouched', async () => {
    setJsonMode(true);
    mockGet
      .mockResolvedValueOnce({ data: [{ id: 'q-1', name: 'ev', provider: 'kafka' }], pagination: { last_page: 1, total: 1 } })
      .mockResolvedValueOnce(kafkaInfo);

    await run(['connection-info', 'ev']);

    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0])).data).toEqual(kafkaInfo);
  });
});

describe('Kafka snippets', () => {
  const tricky = { ...kafkaInfo, password: 'a"b\\c\'d' };

  it('never embeds the password, however it is spelled', () => {
    for (const snippet of [kcatSnippet(tricky), javaPropertiesSnippet(tricky)]) {
      expect(snippet).not.toContain('a"b');
      expect(snippet).not.toContain("c'd");
    }
  });

  it('reads the kcat password from the environment', () => {
    expect(kcatSnippet(kafkaInfo)).toContain('-X sasl.password="$KAFKA_PASSWORD"');
  });

  it('leaves a placeholder for the Java password', () => {
    expect(javaPropertiesSnippet(kafkaInfo)).toContain('password="<password>";');
  });

  it('keeps the password in the plain output, as RabbitMQ does', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGet.mockReset();
    mockGet
      .mockResolvedValueOnce({ data: [{ id: 'q-1', name: 'ev', provider: 'kafka' }], pagination: { last_page: 1, total: 1 } })
      .mockResolvedValueOnce(tricky);

    await run(['connection-info', 'ev']);

    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('a"b\\c\'d');
    log.mockRestore();
  });

  it('accepts matching provider and plan', () => {
    expect(planProblem('kafka', 'kafka-medium')).toBeNull();
    expect(planProblem('rabbitmq', 'small')).toBeNull();
  });
});
