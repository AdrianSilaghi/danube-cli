import { describe, it, expect, vi } from 'vitest';
import { ApiError } from '../src/lib/errors.js';
import { assertSecretsStored, effectiveSecretChanges, ensureSecretSupport, mergeEnv, putMergedEnvironment, reconcileKinds } from '../src/lib/serverless-env.js';
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

  it('leaves the plain variables out, and keeps the snapshot, for a secrets-only change', async () => {
    const put = vi.fn().mockResolvedValue('ok');

    await putMergedEnvironment(fakeApi(put), container({ A: '1' }, 'snap-1'), null, { secret_environment_variables: { K: 'v' } });

    expect(put).toHaveBeenCalledWith('/api/v1/serverless/c-1', {
      secret_environment_variables: { K: 'v' },
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

describe('effectiveSecretChanges', () => {
  it('keeps every value to set and the removals of names the container holds', () => {
    expect(effectiveSecretChanges({ NEW: 'v', HELD: null, ABSENT: null }, ['HELD'])).toEqual({ NEW: 'v', HELD: null });
  });

  it('treats a platform without secret keys as holding none', () => {
    expect(effectiveSecretChanges({ GONE: null }, undefined)).toEqual({});
  });
});

describe('ensureSecretSupport', () => {
  it('returns a container that lists its secret keys without asking again', async () => {
    const get = vi.fn();
    const c = { ...container({}), secret_environment_keys: [] };

    expect(await ensureSecretSupport(fakeApi(vi.fn(), get), c)).toBe(c);
    expect(get).not.toHaveBeenCalled();
  });

  it('returns the freshly read container when only it lists them', async () => {
    const fresh = { ...container({}), secret_environment_keys: ['K'] };
    const get = vi.fn().mockResolvedValue({ container: fresh });

    expect(await ensureSecretSupport(fakeApi(vi.fn(), get), container({}))).toBe(fresh);
  });

  it.each([[{ container: container({}) }], [{}]])('refuses when neither does (%j)', async (answer) => {
    const get = vi.fn().mockResolvedValue(answer);

    await expect(ensureSecretSupport(fakeApi(vi.fn(), get), container({}))).rejects.toThrow(/does not support secret variables yet, so nothing was changed/);
  });
});

describe('assertSecretsStored', () => {
  const made = (keys?: string[]) => ({ ...container({}), name: 'api', secret_environment_keys: keys });

  it('passes when nothing was sent, or all of it is reported', () => {
    expect(() => assertSecretsStored(made(), [])).not.toThrow();
    expect(() => assertSecretsStored(made(['A', 'B']), ['A', 'B'])).not.toThrow();
  });

  it('names what is missing, and whether the platform lacks the feature', () => {
    expect(() => assertSecretsStored(made(), ['A'])).toThrow(/WITHOUT its secret variables.*A.*does not support secret variables yet/);
    expect(() => assertSecretsStored(made(['A']), ['A', 'B'])).toThrow(/WITHOUT some of its secret variables.*B\./);
  });
});

describe('reconcileKinds', () => {
  const now = (env: Record<string, string>, secretKeys: string[]) => ({ environment_variables: env, secret_environment_keys: secretKeys });

  it('moves a plain key that is set as a secret, and a secret key that is set as plain', () => {
    const plan = reconcileKinds(now({ P: '1', Q: '2' }, ['S']), { S: 'plain' }, { P: 'secret' }, ['Q']);

    expect(plan.rmEnv).toEqual(['Q', 'P']);
    expect(plan.secrets).toEqual({ P: 'secret', S: null });
    expect(plan.notes).toEqual(['moved P from plain to secret', 'moved S from secret to plain']);
  });

  it('leaves alone a key already removed, a key that is only removed as a secret, and an empty container', () => {
    const removed = reconcileKinds(now({ P: '1' }, []), {}, { P: 'x' }, ['P']);
    expect(removed.rmEnv).toEqual(['P']);
    expect(removed.notes).toEqual([]);

    const rmSecret = reconcileKinds(now({}, ['S']), { S: 'v' }, { S: null }, undefined);
    expect(rmSecret.secrets).toEqual({ S: null });
    expect(rmSecret.notes).toEqual([]);

    expect(reconcileKinds({ environment_variables: null }, { A: '1' }, { B: 'x' }, undefined)).toEqual({ rmEnv: [], secrets: { B: 'x' }, notes: [] });
  });
});
