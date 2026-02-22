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
});
