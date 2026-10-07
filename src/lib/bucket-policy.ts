import { ApiError, UsageError } from './errors.js';
import type { BucketPolicyStatement } from '../types/api.js';

/** The bucket status that means a change is on its way to the storage gateway. */
export const POLICY_UPDATING = 'updating';

/** Client-side codes for failures the API reports as a bare status. */
export const POLICY_UNAVAILABLE_CODE = 'storage.bucket_policy_unavailable';
export const POLICY_BUSY_CODE = 'storage.bucket_policy_busy';

export const policyPath = (bucketId: string): string => `/api/v1/storage/buckets/${bucketId}/policy`;
export const folderGrantsPath = (bucketId: string): string => `${policyPath(bucketId)}/folder-grants`;

export interface PolicyCall {
  /** The bucket's name, for the messages. */
  bucket: string;
  /** What the call needs of the token: a read, or a change (which reads the answer too). */
  needs: 'read' | 'write';
}

const endWithFullStop = (text: string): string => `${text.replace(/[.\s]+$/, '')}.`;

const NEEDS: Record<PolicyCall['needs'], string> = {
  read: 'Reading a bucket policy needs an API token with the storage:read ability.',
  write: 'Changing a bucket policy needs an API token with both the storage:read and storage:write abilities.',
};

function retryIn(seconds: number | undefined): string {
  if (seconds === undefined || seconds <= 0) return 'a moment';

  return seconds === 1 ? '1 second' : `${seconds} seconds`;
}

/**
 * The failure the policy endpoints report, said in terms of what a person can do.
 *
 * - 404 means one of two things the API does not tell apart: there is no such
 *   bucket, or the policy editor does not cover it — it is off, the bucket is
 *   not on the endpoint that supports policies, or this platform has no policy
 *   routes yet. The message names both rather than choosing.
 * - 403 names the abilities a token needs.
 * - 409 means the bucket's policy was being applied and the change was NOT
 *   saved; it says when to try again.
 *
 * Everything else — 422 with its field messages above all — goes through
 * untouched. The mapped errors stay ApiErrors, so their status, exit code and
 * `--json` shape are the ones every other API failure has.
 *
 * Wrap the policy calls only: a 404 from resolving the bucket or the key is the
 * resolver's to report.
 */
export async function policyApi<T>(call: () => Promise<T>, context: PolicyCall): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;

    switch (err.statusCode) {
      case 404:
        throw new ApiError(
          404,
          `Bucket policy not found for '${context.bucket}': either there is no such bucket, or the bucket policy editor is not available for this bucket or this platform.`,
          undefined,
          { code: POLICY_UNAVAILABLE_CODE, retryable: false },
        );
      case 403:
        throw new ApiError(
          403,
          `${endWithFullStop(err.message)} ${NEEDS[context.needs]}`,
          err.errors,
          err.cause,
          err.meta,
          err.retryAfterSeconds,
        );
      case 409:
        throw new ApiError(
          409,
          `The bucket's policy is being applied, so nothing was saved. Try again in ${retryIn(err.retryAfterSeconds)}.`,
          undefined,
          { code: POLICY_BUSY_CODE, retryable: true },
          err.meta,
          err.retryAfterSeconds,
        );
      default:
        throw err;
    }
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseJson(text: string, origin: string): unknown {
  try {
    // An editor on Windows can put a byte order mark in front of a file.
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new UsageError(`${origin} is not valid JSON: ${(err as Error).message}`);
  }
}

function statementsOf(document: unknown, origin: string): unknown[] {
  if (isObject(document) && 'Statement' in document) {
    if (!Array.isArray(document.Statement)) {
      throw new UsageError(`"Statement" in ${origin} must be a list of statements, even for one statement: wrap it in [ ].`);
    }

    return document.Statement;
  }

  throw new UsageError(
    `${origin} must be a list of statements, or a policy document with a "Statement" list. A single statement goes in a list too: wrap it in [ ].`,
  );
}

/**
 * The custom statements a person wrote, from a list or from a full policy
 * document (`{"Version": ..., "Statement": [...]}`, of which only the list is
 * sent: the API stores statements, not documents).
 *
 * Only the shape is checked here, so that nonsense is refused before anything
 * is sent. Whether a statement says something allowed is the API's to judge,
 * and it names the statement by its position in the list.
 */
export function parsePolicyStatements(text: string, origin: string): BucketPolicyStatement[] {
  const value = parseJson(text, origin);
  const statements = Array.isArray(value) ? value : statementsOf(value, origin);

  statements.forEach((statement, position) => {
    if (!isObject(statement)) {
      throw new UsageError(
        `The statement at position ${position} in ${origin} is not a JSON object (positions count from 0, as in the API's error messages).`,
      );
    }
  });

  return statements as BucketPolicyStatement[];
}
