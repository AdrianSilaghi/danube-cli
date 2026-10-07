import { describe, it, expect } from 'vitest';
import {
  policyApi,
  parsePolicyStatements,
  policyPath,
  folderGrantsPath,
  POLICY_UNAVAILABLE_CODE,
  POLICY_BUSY_CODE,
} from '../src/lib/bucket-policy.js';
import { ApiError, NotAuthenticatedError, UsageError } from '../src/lib/errors.js';

const caught = async (promise: Promise<unknown>): Promise<ApiError> => {
  const err = await promise.then(
    () => { throw new Error('Should have thrown'); },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
};

const asWrite = { bucket: 'invoices', needs: 'write' as const };
const asRead = { bucket: 'invoices', needs: 'read' as const };

describe('policy paths', () => {
  it('addresses the policy and the folder grants by the bucket id', () => {
    expect(policyPath('b-1')).toBe('/api/v1/storage/buckets/b-1/policy');
    expect(folderGrantsPath('b-1')).toBe('/api/v1/storage/buckets/b-1/policy/folder-grants');
  });
});

describe('policyApi', () => {
  it('returns the value when the call succeeds', async () => {
    await expect(policyApi(() => Promise.resolve('ok'), asRead)).resolves.toBe('ok');
  });

  describe('404', () => {
    // The route missing on this server answers the framework's generic "Not Found";
    // a bucket the editor does not cover answers "Bucket not found" or the same
    // generic text. From the outside they are one case, and the message says so.
    it.each(['Not Found', 'Bucket not found'])('names both possible causes, whatever the body says (%s)', async (body) => {
      const err = await caught(policyApi(() => Promise.reject(new ApiError(404, body)), asRead));

      expect(err.statusCode).toBe(404);
      expect(err.message).toContain("'invoices'");
      expect(err.message).toMatch(/no such bucket/i);
      expect(err.message).toMatch(/bucket policy editor is not available for this bucket or this platform/);
    });

    it('is coded, and not worth retrying', async () => {
      const err = await caught(policyApi(() => Promise.reject(new ApiError(404, 'Not Found')), asWrite));

      expect(err.cause).toMatchObject({ code: POLICY_UNAVAILABLE_CODE, retryable: false });
    });
  });

  describe('403', () => {
    it('keeps what the server said and names both abilities a change needs', async () => {
      const err = await caught(policyApi(() => Promise.reject(new ApiError(403, 'Insufficient permissions')), asWrite));

      expect(err.statusCode).toBe(403);
      expect(err.message).toContain('Insufficient permissions');
      expect(err.message).toContain('storage:read');
      expect(err.message).toContain('storage:write');
    });

    it('asks only for storage:read when the call only reads', async () => {
      const err = await caught(policyApi(() => Promise.reject(new ApiError(403, 'Insufficient permissions')), asRead));

      expect(err.message).toContain('storage:read');
      expect(err.message).not.toContain('storage:write');
    });

    it('does not double the full stop when the server message already ends with one', async () => {
      const err = await caught(policyApi(() => Promise.reject(new ApiError(403, 'This action is unauthorized.')), asWrite));

      expect(err.message).toMatch(/^This action is unauthorized\. [A-Z]/);
      expect(err.message).not.toContain('..');
    });

    it('keeps the error code and meta the server sent', async () => {
      const original = new ApiError(403, 'Insufficient permissions', undefined, { code: 'auth.ability_missing' }, { ability: 'storage:write' });

      const err = await caught(policyApi(() => Promise.reject(original), asWrite));

      expect(err.cause).toEqual({ code: 'auth.ability_missing' });
      expect(err.meta).toEqual({ ability: 'storage:write' });
    });
  });

  describe('409', () => {
    it('says the policy is being applied, that nothing was saved, and when to retry', async () => {
      const busy = new ApiError(409, "The bucket's policy is being applied. Try again in a moment.", undefined, undefined, undefined, 5);

      const err = await caught(policyApi(() => Promise.reject(busy), asWrite));

      expect(err.statusCode).toBe(409);
      expect(err.message).toContain("The bucket's policy is being applied");
      expect(err.message).toMatch(/nothing was saved/i);
      expect(err.message).toContain('5 seconds');
      expect(err.retryAfterSeconds).toBe(5);
    });

    it('says "in a moment" when the server gave no Retry-After', async () => {
      const err = await caught(policyApi(() => Promise.reject(new ApiError(409, 'busy')), asWrite));

      expect(err.message).toContain('in a moment');
      expect(err.message).not.toMatch(/\d+ seconds?/);
    });

    it('says "in a moment" for a Retry-After of zero rather than "in 0 seconds"', async () => {
      const err = await caught(policyApi(() => Promise.reject(new ApiError(409, 'busy', undefined, undefined, undefined, 0)), asWrite));

      expect(err.message).toContain('in a moment');
    });

    it('is coded, and worth retrying', async () => {
      const err = await caught(policyApi(() => Promise.reject(new ApiError(409, 'busy')), asWrite));

      expect(err.cause).toMatchObject({ code: POLICY_BUSY_CODE, retryable: true });
    });

    it('says "1 second", not "1 seconds"', async () => {
      const err = await caught(policyApi(() => Promise.reject(new ApiError(409, 'busy', undefined, undefined, undefined, 1)), asWrite));

      expect(err.message).toContain('in 1 second.');
    });
  });

  describe('everything else', () => {
    it('leaves a 422 untouched, so its field messages reach the person', async () => {
      const refused = new ApiError(422, 'Validation failed.', { 'custom_policy_statements.0.Principal': ['not one of this team\'s keys'] });

      await expect(policyApi(() => Promise.reject(refused), asWrite)).rejects.toBe(refused);
    });

    it('leaves a 500 untouched', async () => {
      const boom = new ApiError(500, 'boom');

      await expect(policyApi(() => Promise.reject(boom), asRead)).rejects.toBe(boom);
    });

    it('leaves an error that is not an ApiError untouched', async () => {
      const lost = new NotAuthenticatedError();
      const network = new Error('Could not reach GET https://x (ECONNREFUSED).');

      await expect(policyApi(() => Promise.reject(lost), asRead)).rejects.toBe(lost);
      await expect(policyApi(() => Promise.reject(network), asRead)).rejects.toBe(network);
    });
  });
});

describe('parsePolicyStatements', () => {
  const allow = { Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::dd-1-b/*'] };
  const deny = { Effect: 'Deny', Principal: '*', Action: ['s3:DeleteObject'] };

  const usageError = (text: string): string => {
    try {
      parsePolicyStatements(text, '--statements');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      return (err as Error).message;
    }
    throw new Error('Should have thrown');
  };

  it('takes a bare list as it is', () => {
    expect(parsePolicyStatements(JSON.stringify([allow, deny]), '--statements')).toEqual([allow, deny]);
  });

  it('takes the Statement list of a full policy document and drops the rest of it', () => {
    const document = { Version: '2012-10-17', Id: 'mine', Statement: [allow, deny] };

    expect(parsePolicyStatements(JSON.stringify(document), '--file policy.json')).toEqual([allow, deny]);
  });

  it('accepts an empty list, which removes every custom statement', () => {
    expect(parsePolicyStatements('[]', '--statements')).toEqual([]);
    expect(parsePolicyStatements('{"Version":"2012-10-17","Statement":[]}', '--statements')).toEqual([]);
  });

  it('tolerates the byte order mark an editor on Windows puts in front of a file', () => {
    expect(parsePolicyStatements(`﻿${JSON.stringify([allow])}`, '--file policy.json')).toEqual([allow]);
  });

  it('tolerates whitespace around the document', () => {
    expect(parsePolicyStatements(`\n  ${JSON.stringify([allow])}\n`, 'the standard input')).toEqual([allow]);
  });

  it('does not judge what a statement says: that is the API\'s to check', () => {
    expect(parsePolicyStatements('[{"Effect":"Maybe"}]', '--statements')).toEqual([{ Effect: 'Maybe' }]);
  });

  it('refuses text that is not JSON, naming where it came from and what the parser said', () => {
    const message = usageError('[{"Effect": ');

    expect(message).toContain('--statements');
    expect(message).toMatch(/not valid JSON: /);
  });

  it('refuses empty text', () => {
    expect(usageError('')).toMatch(/not valid JSON/);
    expect(usageError('   ')).toMatch(/not valid JSON/);
  });

  it.each(['"text"', '42', 'null', 'true'])('refuses JSON that is neither a list nor a document (%s)', (text) => {
    expect(usageError(text)).toMatch(/list of statements/);
  });

  it('refuses a single statement and says to wrap it in a list', () => {
    const message = usageError(JSON.stringify(allow));

    expect(message).toMatch(/wrap/i);
    expect(message).toContain('[ ]');
  });

  it('refuses a document whose Statement is one object rather than a list', () => {
    const message = usageError(JSON.stringify({ Version: '2012-10-17', Statement: allow }));

    expect(message).toMatch(/"Statement" .* must be a list/);
    expect(message).toContain('[ ]');
  });

  it.each([
    ['a number', '[{"Effect":"Allow"}, 5]', 1],
    ['null', '[null]', 0],
    ['a nested list', '[{"Effect":"Allow"}, {"Effect":"Deny"}, []]', 2],
    ['a string', '["Allow"]', 0],
  ])('refuses a list with %s in it, naming the position counted from 0', (_name, text, position) => {
    const message = usageError(text);

    expect(message).toContain(`position ${position}`);
    expect(message).toMatch(/JSON object/);
  });
});
