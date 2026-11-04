import { describe, it, expect, vi } from 'vitest';
import { ApiError } from '../src/lib/errors.js';
import { mergeEnv, putMergedEnvironment } from '../src/lib/serverless-env.js';
import type { ApiClient } from '../src/lib/api-client.js';
import type { ServerlessContainer } from '../src/types/api.js';

const container = (env: Record<string, string>, snapshot?: string): ServerlessContainer =>
  ({ id: 'c-1', environment_variables: env, environment_snapshot: snapshot }) as ServerlessContainer;

const refusal = (field: string) =>
  new ApiError(422, 'Validation failed.', { [field]: ['Environment variables changed since this form was opened.'] });

function fakeApi(put: ReturnType<typeof vi.fn>, get = vi.fn()): ApiClient {
  return { put, get } as unknown as ApiClient;
}

describe('mergeEnv', () => {
  it('removes named keys, then overlays the pairs', () => {
    expect(mergeEnv({ A: '1', B: '2' }, { B: '3', C: '4' }, ['A'])).toEqual({ B: '3', C: '4' });
  });

  it('starts from an empty map when the container has none', () => {
    expect(mergeEnv(null, { A: '1' }, undefined)).toEqual({ A: '1' });
  });
});

describe('putMergedEnvironment', () => {
  const merge = (env: Record<string, string> | null) => mergeEnv(env, { NEW: 'v' }, undefined);

  it('sends the snapshot of the container the merge was built from', async () => {
    const put = vi.fn().mockResolvedValue('ok');

    await putMergedEnvironment(fakeApi(put), container({ A: '1' }, 'snap-1'), merge, { port: 80 });

    expect(put).toHaveBeenCalledWith('/api/v1/serverless/c-1', {
      port: 80,
      environment_variables: { A: '1', NEW: 'v' },
      environment_snapshot: 'snap-1',
    });
  });

  it('omits the snapshot when the API did not return one', async () => {
    const put = vi.fn().mockResolvedValue('ok');

    await putMergedEnvironment(fakeApi(put), container({ A: '1' }), merge, {});

    expect(put.mock.calls[0]![1]).not.toHaveProperty('environment_snapshot');
  });

  it.each(['environment_variables', 'environment_snapshot'])(
    're-reads and retries once when the API refuses on %s',
    async (field) => {
      const put = vi.fn().mockRejectedValueOnce(refusal(field)).mockResolvedValueOnce('ok');
      const get = vi.fn().mockResolvedValue({ container: container({ A: '1', OTHER: 'x' }, 'snap-2') });

      await expect(putMergedEnvironment(fakeApi(put, get), container({ A: '1' }, 'snap-1'), merge, {})).resolves.toBe('ok');

      expect(get).toHaveBeenCalledWith('/api/v1/serverless/c-1');
      expect(put).toHaveBeenLastCalledWith('/api/v1/serverless/c-1', {
        environment_variables: { A: '1', OTHER: 'x', NEW: 'v' },
        environment_snapshot: 'snap-2',
      });
    },
  );

  it('gives up after one retry', async () => {
    const put = vi.fn().mockRejectedValue(refusal('environment_variables'));
    const get = vi.fn().mockResolvedValue({ container: container({}, 'snap-2') });

    await expect(putMergedEnvironment(fakeApi(put, get), container({}, 'snap-1'), merge, {})).rejects.toBeInstanceOf(ApiError);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('does not retry other failures', async () => {
    const put = vi.fn().mockRejectedValue(new ApiError(422, 'bad', { port: ['invalid'] }));
    const get = vi.fn();

    await expect(putMergedEnvironment(fakeApi(put, get), container({}), merge, {})).rejects.toBeInstanceOf(ApiError);
    expect(get).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledTimes(1);
  });
});
