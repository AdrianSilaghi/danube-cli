import { describe, it, expect, vi } from 'vitest';
import {
  parseBucketGrant,
  parseKeyLevel,
  readKeyScopeFlags,
  resolveAccessKey,
  keyState,
  KEY_LEVELS,
  KEY_SCOPES,
  MAX_BUCKET_PERMISSIONS,
} from '../src/lib/storage-keys.js';
import { ResourceNotFoundError, UsageError } from '../src/lib/errors.js';
import type { ApiClient } from '../src/lib/api-client.js';

const usageMessage = (attempt: () => unknown): string => {
  try {
    attempt();
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError);
    return (err as Error).message;
  }
  throw new Error('Should have thrown');
};

describe('key scopes and levels', () => {
  it('are the ones the API takes', () => {
    expect([...KEY_SCOPES]).toEqual(['team', 'buckets', 'none']);
    expect([...KEY_LEVELS]).toEqual(['read', 'readwrite', 'full']);
    expect(MAX_BUCKET_PERMISSIONS).toBe(50);
  });
});

describe('parseBucketGrant', () => {
  it('splits a bucket and a level', () => {
    expect(parseBucketGrant('invoices:read')).toEqual({ bucket: 'invoices', level: 'read' });
    expect(parseBucketGrant('logs:readwrite')).toEqual({ bucket: 'logs', level: 'readwrite' });
    expect(parseBucketGrant('3f0c6a52-0e4b-4a3a-9d56-7c1d2b1a0001:full'))
      .toEqual({ bucket: '3f0c6a52-0e4b-4a3a-9d56-7c1d2b1a0001', level: 'full' });
  });

  it('splits at the last colon, so the level is always what follows it', () => {
    expect(parseBucketGrant('odd:name:full')).toEqual({ bucket: 'odd:name', level: 'full' });
  });

  it('ignores spaces around either part', () => {
    expect(parseBucketGrant(' invoices : read ')).toEqual({ bucket: 'invoices', level: 'read' });
  });

  it('refuses a bucket given without a level and shows the form', () => {
    const message = usageMessage(() => parseBucketGrant('invoices'));

    expect(message).toContain("--bucket 'invoices'");
    expect(message).toContain('<bucket>:<level>');
    expect(message).toContain('invoices:readwrite');
  });

  it.each([':read', ' :read'])('refuses a level with no bucket (%j)', (value) => {
    expect(usageMessage(() => parseBucketGrant(value))).toContain('names no bucket');
  });

  it.each(['invoices:', 'invoices: '])('refuses a bucket with no level (%j) rather than choosing one', (value) => {
    expect(usageMessage(() => parseBucketGrant(value))).toContain('read, readwrite or full');
  });

  it.each(['invoices:admin', 'invoices:Read', 'invoices:READ', 'invoices:write'])(
    'refuses the level in %j and lists the three that exist',
    (value) => {
      const message = usageMessage(() => parseBucketGrant(value));

      expect(message).toContain('read, readwrite or full');
      expect(message).toContain(value.split(':').pop()!);
    },
  );
});

describe('parseKeyLevel', () => {
  it.each(KEY_LEVELS)('accepts %s', (level) => {
    expect(parseKeyLevel(level, '--level')).toBe(level);
  });

  it('refuses anything else and names the flag it came from', () => {
    const message = usageMessage(() => parseKeyLevel('admin', '--level'));

    expect(message).toContain('--level');
    expect(message).toContain("'admin'");
    expect(message).toContain('read, readwrite or full');
  });
});

describe('readKeyScopeFlags', () => {
  it('asks for nothing when no scope flag is given: an old-style create stays a team key', () => {
    expect(readKeyScopeFlags(undefined, [])).toEqual({ scope: undefined, grants: [] });
  });

  it('keeps an explicit scope team or none', () => {
    expect(readKeyScopeFlags('team', [])).toEqual({ scope: 'team', grants: [] });
    expect(readKeyScopeFlags('none', [])).toEqual({ scope: 'none', grants: [] });
  });

  it('turns --bucket values into grants, in the order given', () => {
    expect(readKeyScopeFlags('buckets', ['a:read', 'b:full'])).toEqual({
      scope: 'buckets',
      grants: [{ bucket: 'a', level: 'read' }, { bucket: 'b', level: 'full' }],
    });
  });

  it('refuses --bucket without a scope instead of guessing one, and says why', () => {
    const message = usageMessage(() => readKeyScopeFlags(undefined, ['a:read']));

    expect(message).toContain('--bucket needs --scope buckets');
    expect(message).toContain('every bucket');
  });

  it('refuses --scope buckets without a bucket', () => {
    expect(usageMessage(() => readKeyScopeFlags('buckets', []))).toContain('--scope buckets needs at least one --bucket');
  });

  it.each(['team', 'none'])('refuses --scope %s together with --bucket, and points at --scope buckets', (scope) => {
    const message = usageMessage(() => readKeyScopeFlags(scope, ['a:read']));

    expect(message).toContain(`--scope ${scope} takes no --bucket`);
    expect(message).toContain('--scope buckets');
  });

  it('allows fifty buckets and refuses fifty-one', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `b${i}:read`);

    expect(readKeyScopeFlags('buckets', fifty).grants).toHaveLength(50);
    expect(usageMessage(() => readKeyScopeFlags('buckets', [...fifty, 'b50:read']))).toContain('at most 50');
  });

  it.each(['everything', 'Team', 'BUCKETS', ''])('refuses the scope %j and lists the three that exist', (scope) => {
    const message = usageMessage(() => readKeyScopeFlags(scope, []));

    expect(message).toContain('--scope');
    expect(message).toContain('team, buckets or none');
  });

  it('reports a malformed --bucket before anything else about the combination', () => {
    expect(usageMessage(() => readKeyScopeFlags('buckets', ['a:read', 'oops']))).toContain("--bucket 'oops'");
  });
});

const uuid = (n: number): string => `3f0c6a52-0e4b-4a3a-9d56-7c1d2b1a${String(n).padStart(4, '0')}`;

const key = (overrides: Record<string, unknown> = {}) => ({
  id: uuid(1),
  team_id: 4,
  name: 'invoices-service',
  access_key_id: 'DDAKINVOICES0000001',
  arn: 'arn:aws:iam:::user/team-4-sk-aaaaaaaa',
  scope: 'none',
  status: 'active',
  is_expired: false,
  expires_at: null,
  last_used_at: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...overrides,
});

const apiWithOnlyUnusableKeys = () =>
  apiListing([
    key({ id: uuid(1), name: 'old', status: 'revoked' }),
    key({ id: uuid(2), name: 'old', status: 'active', is_expired: true }),
  ]);

const apiListing = (items: unknown[], total = items.length) =>
  ({
    get: vi.fn().mockResolvedValue({ data: items, pagination: { current_page: 1, last_page: 1, per_page: 100, total } }),
  }) as unknown as ApiClient & { get: ReturnType<typeof vi.fn> };

describe('keyState', () => {
  it('is the status, except that a key past its expiry date is "expired" whatever its status says', () => {
    expect(keyState(key({ status: 'active', is_expired: false }))).toBe('active');
    expect(keyState(key({ status: 'active' }))).toBe('active');
    expect(keyState(key({ status: 'active', is_expired: true }))).toBe('expired');
    expect(keyState(key({ status: 'revoked', is_expired: true }))).toBe('revoked');
    expect(keyState(key({ status: 'error' }))).toBe('error');
  });
});

describe('resolveAccessKey', () => {
  it('finds a key by its id', async () => {
    const api = apiListing([key({ id: uuid(1), name: 'one' }), key({ id: uuid(2), name: 'two' })]);

    expect((await resolveAccessKey(api, uuid(2))).name).toBe('two');
  });

  it('finds a key by its S3 access key id', async () => {
    const api = apiListing([key({ id: uuid(1), name: 'one', access_key_id: 'DDAKONE' }), key({ id: uuid(2), name: 'two', access_key_id: 'DDAKTWO' })]);

    expect((await resolveAccessKey(api, 'DDAKTWO')).id).toBe(uuid(2));
  });

  it('finds a key by its name', async () => {
    const api = apiListing([key({ id: uuid(1), name: 'one' }), key({ id: uuid(2), name: 'two' })]);

    expect((await resolveAccessKey(api, 'two')).id).toBe(uuid(2));
  });

  it('reads the key list once, in full pages', async () => {
    const api = apiListing([key()]);

    await resolveAccessKey(api, 'invoices-service');

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith('/api/v1/storage/access-keys?per_page=100&page=1');
  });

  it('lets an id outrank a name, and an access key id outrank a name', async () => {
    const api = apiListing([
      key({ id: uuid(1), name: uuid(2), access_key_id: 'DDAK1' }),
      key({ id: uuid(2), name: 'second', access_key_id: 'DDAK2' }),
      key({ id: uuid(3), name: 'DDAK2', access_key_id: 'DDAK3' }),
    ]);

    expect((await resolveAccessKey(api, uuid(2))).name).toBe('second');
    expect((await resolveAccessKey(api, 'DDAK2')).name).toBe('second');
  });

  it('does not match on a prefix of an id or a name', async () => {
    const api = apiListing([key({ id: uuid(1), name: 'invoices-service' })]);

    await expect(resolveAccessKey(api, uuid(1).slice(0, 12))).rejects.toThrow(ResourceNotFoundError);
    await expect(resolveAccessKey(api, 'invoices')).rejects.toThrow(ResourceNotFoundError);
  });

  describe('when the name is shared', () => {
    const SECRET = 'wJalrXUtnFEMI/SHOULD-NEVER-BE-PRINTED';

    it('refuses to choose between two usable keys, and lists them by id and name', async () => {
      const api = apiListing([
        key({ id: uuid(1), name: 'invoices-service', secret_access_key: SECRET }),
        key({ id: uuid(2), name: 'invoices-service', secret_access_key: SECRET }),
      ]);

      const err = await resolveAccessKey(api, 'invoices-service').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(UsageError);
      const message = (err as Error).message;
      expect(message).toContain("'invoices-service'");
      expect(message).toContain(uuid(1));
      expect(message).toContain(uuid(2));
      expect(message).toMatch(/Use the key's id/);
    });

    it('never puts a secret in the message, even if a response carried one', async () => {
      const api = apiListing([
        key({ id: uuid(1), name: 'twin', secret_access_key: SECRET }),
        key({ id: uuid(2), name: 'twin', secret_access_key: SECRET }),
      ]);

      const err = await resolveAccessKey(api, 'twin').catch((e: unknown) => e);

      expect((err as Error).message).not.toContain(SECRET);
      expect((err as Error).message).not.toContain('wJalr');
    });

    it('shows each key\'s state, so a person can tell them apart', async () => {
      const api = apiListing([
        key({ id: uuid(1), name: 'twin', status: 'active' }),
        key({ id: uuid(2), name: 'twin', status: 'active', is_expired: true }),
        key({ id: uuid(3), name: 'twin', status: 'active' }),
      ]);

      const message = ((await resolveAccessKey(api, 'twin').catch((e: unknown) => e)) as Error).message;

      expect(message).toContain(`${uuid(1)}  twin  active`);
      expect(message).toContain(`${uuid(3)}  twin  active`);
      // The expired one is not a choice, so it is not offered.
      expect(message).not.toContain(uuid(2));
    });

    it('takes the one usable key when the others are revoked: a rotated key keeps its name', async () => {
      const api = apiListing([
        key({ id: uuid(1), name: 'invoices-service', status: 'revoked' }),
        key({ id: uuid(2), name: 'invoices-service', status: 'active' }),
        key({ id: uuid(3), name: 'invoices-service', status: 'revoked' }),
      ]);

      expect((await resolveAccessKey(api, 'invoices-service')).id).toBe(uuid(2));
    });

    it('treats an expired key like a revoked one when choosing', async () => {
      const api = apiListing([
        key({ id: uuid(1), name: 'invoices-service', status: 'active', is_expired: true }),
        key({ id: uuid(2), name: 'invoices-service', status: 'active', is_expired: false }),
      ]);

      expect((await resolveAccessKey(api, 'invoices-service')).id).toBe(uuid(2));
    });

    it('still refuses when every key with the name is unusable and there are several', async () => {
      const api = apiListing([
        key({ id: uuid(1), name: 'old', status: 'revoked' }),
        key({ id: uuid(2), name: 'old', status: 'revoked' }),
      ]);

      await expect(resolveAccessKey(api, 'old')).rejects.toThrow(/Use the key's id/);
    });

    it('says why each of several unusable keys is one: revoked, or expired', async () => {
      const api = apiWithOnlyUnusableKeys();

      const message = ((await resolveAccessKey(api, 'old').catch((e: unknown) => e)) as Error).message;

      expect(message).toContain(`${uuid(1)}  old  revoked`);
      expect(message).toContain(`${uuid(2)}  old  expired`);
    });

    it('returns a lone unusable key as it is: the API says why it cannot be used', async () => {
      const api = apiListing([key({ id: uuid(1), name: 'old', status: 'revoked' })]);

      expect((await resolveAccessKey(api, 'old')).status).toBe('revoked');
    });
  });

  describe('a listing read in several pages', () => {
    // The list is newest first and paged by offset: a key created between two page reads
    // pushes the last key of page 1 onto page 2, so it is listed twice.
    const pages = (...perPage: unknown[][]) =>
      ({
        get: vi.fn((path: string) => {
          const number = Number(/[?&]page=(\d+)/.exec(path)![1]);   // not `per_page=100`
          return Promise.resolve({
            data: perPage[number - 1] ?? [],
            pagination: { current_page: number, last_page: perPage.length, per_page: 2, total: 3 },
          });
        }),
      }) as unknown as ApiClient;

    it('does not read a key listed twice as two keys with the same name', async () => {
      const api = pages(
        [key({ id: uuid(1), name: 'one' }), key({ id: uuid(2), name: 'two' })],
        [key({ id: uuid(2), name: 'two' }), key({ id: uuid(3), name: 'three' })],
      );

      const hit = await resolveAccessKey(api, 'two');

      expect(hit.id).toBe(uuid(2));
    });

    it('still refuses two DIFFERENT keys with one name', async () => {
      const api = pages(
        [key({ id: uuid(1), name: 'twin' }), key({ id: uuid(2), name: 'twin' })],
        [key({ id: uuid(2), name: 'twin' }), key({ id: uuid(3), name: 'three' })],
      );

      const message = ((await resolveAccessKey(api, 'twin').catch((e: unknown) => e)) as Error).message;

      expect(message).toContain('2 keys match');
      expect(message.match(new RegExp(uuid(2), 'g'))).toHaveLength(1);
    });

    it('still says the list was cut short, counting each key once', async () => {
      // The same two keys on every page, up to the 20-page limit, of 5000 keys in all.
      const api = {
        get: vi.fn().mockResolvedValue({
          data: [key({ id: uuid(1), name: 'one' }), key({ id: uuid(2), name: 'two' })],
          pagination: { current_page: 1, last_page: 25, per_page: 2, total: 5_000 },
        }),
      } as unknown as ApiClient;

      await expect(resolveAccessKey(api, 'nope')).rejects.toThrow(/only 2 of 5000 were searched/);
    });
  });

  describe('when nothing matches', () => {
    it('says so as a not-found error that names the reference and how to list the keys', async () => {
      const api = apiListing([key()]);

      const err = await resolveAccessKey(api, 'nope').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ResourceNotFoundError);
      expect((err as Error).message).toContain("'nope'");
      expect((err as Error).message).toContain('danube storage keys ls');
    });

    it('says how many keys were searched when the listing was cut short', async () => {
      const api = apiListing([key()], 5_000);

      await expect(resolveAccessKey(api, 'nope')).rejects.toThrow(/only 1 of 5000 were searched/);
    });
  });

  it('refuses an empty reference without calling the API', async () => {
    const api = apiListing([key()]);

    await expect(resolveAccessKey(api, '')).rejects.toThrow(UsageError);
    await expect(resolveAccessKey(api, '   ')).rejects.toThrow(/Empty key/);
    expect(api.get).not.toHaveBeenCalled();
  });
});
