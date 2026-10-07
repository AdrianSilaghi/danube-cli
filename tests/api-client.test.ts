import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApiError, NotAuthenticatedError } from '../src/lib/errors.js';

const mockReadConfig = vi.fn();
vi.mock('../src/lib/config.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/config.js')>('../src/lib/config.js');
  return {
    ...actual,
    readConfig: (...args: unknown[]) => mockReadConfig(...args),
  };
});

const { ApiClient } = await import('../src/lib/api-client.js');

describe('ApiClient', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Reset fetch mock before each test
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends GET request with auth header', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: 'test' }),
    });

    const client = new ApiClient('my-token', 'https://api.test');
    const result = await client.get<{ data: string }>('/api/v1/sites');

    expect(fetch).toHaveBeenCalledWith('https://api.test/api/v1/sites', expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({
        'Accept': 'application/json',
        'Authorization': 'Bearer my-token',
      }),
    }));
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[1].signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({ data: 'test' });
  });

  it('sends POST request with JSON body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ message: 'created' }),
    });

    const client = new ApiClient('my-token', 'https://api.test');
    await client.post('/api/v1/sites', { name: 'test' });

    expect(fetch).toHaveBeenCalledWith('https://api.test/api/v1/sites', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'Accept': 'application/json',
        'Authorization': 'Bearer my-token',
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ name: 'test' }),
    }));
  });

  it('throws NotAuthenticatedError on 401', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ message: 'Unauthenticated' }),
    });

    const client = new ApiClient('bad-token', 'https://api.test');
    await expect(client.get('/api/user')).rejects.toThrow(NotAuthenticatedError);
  });

  it('throws ApiError on 422 with validation errors', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: () => Promise.resolve({
        message: 'Validation failed',
        errors: { name: ['The name field is required.'] },
      }),
    });

    const client = new ApiClient('my-token', 'https://api.test');

    try {
      await client.post('/api/v1/sites', {});
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.statusCode).toBe(422);
      expect(apiErr.errors?.name).toEqual(['The name field is required.']);
    }
  });

  it('handles 204 No Content', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
    });

    const client = new ApiClient('my-token', 'https://api.test');
    const result = await client.delete('/api/v1/sites/1');
    expect(result).toBeUndefined();
  });

  it('sends PUT request with JSON body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ message: 'updated' }),
    });

    const client = new ApiClient('my-token', 'https://api.test');
    await client.put('/api/v1/serverless/abc', { image: 'nginx' });

    expect(fetch).toHaveBeenCalledWith('https://api.test/api/v1/serverless/abc', expect.objectContaining({
      method: 'PUT',
      headers: expect.objectContaining({
        'Accept': 'application/json',
        'Authorization': 'Bearer my-token',
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ image: 'nginx' }),
    }));
  });

  it('sends PATCH request with JSON body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: 'patched' }),
    });

    const client = new ApiClient('my-token', 'https://api.test');
    await client.patch('/api/v1/uptime/abc', { paused: true });

    expect(fetch).toHaveBeenCalledWith('https://api.test/api/v1/uptime/abc', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ paused: true }),
    }));
  });

  it('throws ApiError on 500', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ message: 'Server error' }),
    });

    const client = new ApiClient('my-token', 'https://api.test');
    await expect(client.get('/api/v1/sites')).rejects.toThrow(ApiError);
  });

  it('uses default error message when json has no message', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
    });

    const client = new ApiClient('my-token', 'https://api.test');
    try {
      await client.get('/api/v1/sites');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).message).toBe('Request failed with status 503');
    }
  });

  it('handles json parse failure gracefully', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error('invalid json')),
    });

    const client = new ApiClient('my-token', 'https://api.test');
    try {
      await client.get('/api/v1/sites');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).message).toBe('Request failed with status 502');
    }
  });

  it('upload sends FormData with file', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ message: 'ok' }),
    });

    const client = new ApiClient('my-token', 'https://api.test');
    const file = new Uint8Array([1, 2, 3]);
    const result = await client.upload('/api/v1/upload', file, 'test.tar.gz');

    expect(result).toEqual({ message: 'ok' });
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe('https://api.test/api/v1/upload');
    expect(call[1].body).toBeInstanceOf(FormData);
    // Should NOT set Content-Type (browser/node sets it with boundary)
    expect(call[1].headers['Content-Type']).toBeUndefined();
  });

  it('throws descriptive error when request times out', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      new DOMException('The operation was aborted.', 'AbortError'),
    );

    const client = new ApiClient('my-token', 'https://api.test');
    await expect(client.get('/api/v1/slow')).rejects.toThrow(
      'Request timed out after 30000ms: GET /api/v1/slow',
    );
  });

  describe('a GET with its own timeout', () => {
    // A fetch that never answers and gives up when it is aborted, as a hung server would.
    const hungServer = () =>
      vi.fn((_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
        }));

    afterEach(() => {
      vi.useRealTimers();
    });

    it('is cut at the time it was given, and says how long that was', async () => {
      vi.useFakeTimers();
      globalThis.fetch = hungServer() as never;
      let outcome: unknown = 'pending';
      const request = new ApiClient('my-token', 'https://api.test').get('/api/v1/slow', 2_000)
        .catch((err: unknown) => { outcome = err; });

      await vi.advanceTimersByTimeAsync(1_999);
      expect(outcome).toBe('pending');

      await vi.advanceTimersByTimeAsync(1);
      await request;
      expect((outcome as Error).message).toBe('Request timed out after 2000ms: GET /api/v1/slow');
    });

    it('keeps the 30 second default when no timeout is given', async () => {
      vi.useFakeTimers();
      globalThis.fetch = hungServer() as never;
      let outcome: unknown = 'pending';
      const request = new ApiClient('my-token', 'https://api.test').get('/api/v1/slow')
        .catch((err: unknown) => { outcome = err; });

      await vi.advanceTimersByTimeAsync(29_999);
      expect(outcome).toBe('pending');

      await vi.advanceTimersByTimeAsync(1);
      await request;
      expect((outcome as Error).message).toBe('Request timed out after 30000ms: GET /api/v1/slow');
    });
  });

  it('passes abort signal to fetch', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: 'ok' }),
    });

    const client = new ApiClient('my-token', 'https://api.test');
    await client.get('/api/v1/sites');

    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[1].signal).toBeInstanceOf(AbortSignal);
  });

  it('uses default baseUrl when none provided', () => {
    const client = new ApiClient('my-token');
    // Just verify it doesn't throw — default base is used
    expect(client).toBeDefined();
  });

  describe('create()', () => {
    it('throws NotAuthenticatedError when no token', async () => {
      const origToken = process.env.DANUBE_TOKEN;
      delete process.env.DANUBE_TOKEN;
      mockReadConfig.mockResolvedValueOnce(null);

      await expect(ApiClient.create()).rejects.toThrow(NotAuthenticatedError);

      if (origToken) process.env.DANUBE_TOKEN = origToken;
    });

    it('creates client from env token', async () => {
      process.env.DANUBE_TOKEN = 'env-test-token';
      mockReadConfig.mockResolvedValueOnce({ token: 'env-test-token' });

      const client = await ApiClient.create();
      expect(client).toBeInstanceOf(ApiClient);

      delete process.env.DANUBE_TOKEN;
    });

    describe('project scoping', () => {
      const teamHeader = async (client: InstanceType<typeof ApiClient>) => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
        globalThis.fetch = fetchMock;
        await client.get('/api/v1/static-sites');
        return (fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }).headers['X-Team-Id'];
      };

      afterEach(async () => {
        const { setProjectOverride } = await import('../src/lib/project-context.js');
        setProjectOverride(null);
      });

      it('scopes to the saved project by default', async () => {
        mockReadConfig.mockResolvedValueOnce({ token: 't', teamId: 20 });

        expect(await teamHeader(await ApiClient.create())).toBe('20');
      });

      /**
       * A linked static site belongs to one project; pinning the client to it
       * is what stops `danube project use` elsewhere from turning every pages
       * request into a 404.
       */
      it('lets a pinned project outrank --project and the saved one', async () => {
        const { setProjectOverride } = await import('../src/lib/project-context.js');
        setProjectOverride(7);
        mockReadConfig.mockResolvedValueOnce({ token: 't', teamId: 20 });

        expect(await teamHeader(await ApiClient.create({ teamId: 4 }))).toBe('4');
      });

      it('falls back to the usual selection when the pin is null', async () => {
        mockReadConfig.mockResolvedValueOnce({ token: 't', teamId: 20 });

        expect(await teamHeader(await ApiClient.create({ teamId: null }))).toBe('20');
      });
    });
  });

  describe('Retry-After', () => {
    const failing = (headers?: Headers) =>
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        headers,
        json: () => Promise.resolve({ error: 'The bucket\'s policy is being applied. Try again in a moment.' }),
      });

    const retryAfterOf = async (headers?: Headers): Promise<number | undefined> => {
      globalThis.fetch = failing(headers);
      try {
        await new ApiClient('my-token', 'https://api.test').put('/api/v1/storage/buckets/b/policy', {});
      } catch (err) {
        return (err as ApiError).retryAfterSeconds;
      }
      throw new Error('Should have thrown');
    };

    it('carries a Retry-After given in seconds on the ApiError', async () => {
      expect(await retryAfterOf(new Headers({ 'Retry-After': '5' }))).toBe(5);
    });

    it('keeps a Retry-After of zero, which means "now"', async () => {
      expect(await retryAfterOf(new Headers({ 'Retry-After': '0' }))).toBe(0);
    });

    it('leaves it undefined when the header is absent', async () => {
      expect(await retryAfterOf(new Headers())).toBeUndefined();
    });

    it('leaves it undefined when the response carries no headers object at all', async () => {
      expect(await retryAfterOf(undefined)).toBeUndefined();
    });

    it.each(['soon', 'Fri, 31 Dec 1999 23:59:59 GMT', '-3', '1.5', ''])(
      'ignores a Retry-After it cannot read as whole seconds (%j)',
      async (value) => {
        expect(await retryAfterOf(new Headers({ 'Retry-After': value }))).toBeUndefined();
      },
    );

    it('still reports the message and status of the failure', async () => {
      globalThis.fetch = failing(new Headers({ 'Retry-After': '5' }));

      await expect(new ApiClient('my-token', 'https://api.test').put('/api/v1/storage/buckets/b/policy', {}))
        .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('being applied') });
    });
  });

  it('unwraps the cause of undici fetch failures', async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
    globalThis.fetch = vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause }));

    const client = new ApiClient('tok', 'http://127.0.0.1:9');
    await expect(client.get('/api/v1/vps')).rejects.toThrow(
      /GET http:\/\/127\.0\.0\.1:9\/api\/v1\/vps \(ECONNREFUSED\)/,
    );
  });
});
