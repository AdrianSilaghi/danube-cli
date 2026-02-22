import { describe, it, expect } from 'vitest';
import { NotAuthenticatedError, NotLinkedError, ApiError } from '../src/lib/errors.js';

describe('errors', () => {
  it('NotAuthenticatedError has correct message and name', () => {
    const err = new NotAuthenticatedError();
    expect(err.message).toBe('Not authenticated. Run `danube login` first.');
    expect(err.name).toBe('NotAuthenticatedError');
    expect(err).toBeInstanceOf(Error);
  });

  it('NotLinkedError has correct message and name', () => {
    const err = new NotLinkedError();
    expect(err.message).toBe('No project linked. Run `danube link` first.');
    expect(err.name).toBe('NotLinkedError');
    expect(err).toBeInstanceOf(Error);
  });

  it('ApiError has correct properties', () => {
    const err = new ApiError(422, 'Validation failed', { name: ['Required'] });
    expect(err.statusCode).toBe(422);
    expect(err.message).toBe('Validation failed');
    expect(err.errors).toEqual({ name: ['Required'] });
    expect(err.name).toBe('ApiError');
    expect(err).toBeInstanceOf(Error);
  });

  it('ApiError works without errors object', () => {
    const err = new ApiError(500, 'Server error');
    expect(err.statusCode).toBe(500);
    expect(err.errors).toBeUndefined();
  });
});
