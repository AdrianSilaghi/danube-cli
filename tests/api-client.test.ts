import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApiClient } from '../src/lib/api-client.js';
import { ApiError, NotAuthenticatedError } from '../src/lib/errors.js';

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

    expect(fetch).toHaveBeenCalledWith('https://api.test/api/v1/sites', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': 'Bearer my-token',
      },
    });
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

    expect(fetch).toHaveBeenCalledWith('https://api.test/api/v1/sites', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Authorization': 'Bearer my-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'test' }),
    });
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

  it('uses default baseUrl when none provided', () => {
    const client = new ApiClient('my-token');
    // Just verify it doesn't throw — default base is used
    expect(client).toBeDefined();
  });

  describe('create()', () => {
    it('throws NotAuthenticatedError when no token', async () => {
      const origToken = process.env.DANUBE_TOKEN;
      delete process.env.DANUBE_TOKEN;

      await expect(ApiClient.create()).rejects.toThrow(NotAuthenticatedError);

      if (origToken) process.env.DANUBE_TOKEN = origToken;
    });

    it('creates client from env token', async () => {
      process.env.DANUBE_TOKEN = 'env-test-token';

      const client = await ApiClient.create();
      expect(client).toBeInstanceOf(ApiClient);

      delete process.env.DANUBE_TOKEN;
    });
  });
});
