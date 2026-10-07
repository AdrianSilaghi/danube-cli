import { describe, it, expect } from 'vitest';
import { NotAuthenticatedError, NotLinkedError, ApiError, MissingFlagsError, ConfirmationRequiredError, ResourceNotFoundError } from '../src/lib/errors.js';

describe('errors', () => {
  it('NotAuthenticatedError has correct message and name', () => {
    const err = new NotAuthenticatedError();
    expect(err.message).toBe('Not authenticated. Run `danube login` first.');
    expect(err.name).toBe('NotAuthenticatedError');
    expect(err).toBeInstanceOf(Error);
  });

  it('NotLinkedError has correct message and name', () => {
    const err = new NotLinkedError();
    expect(err.message).toBe('No project linked. Run `danube pages link` first.');
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

describe('MissingFlagsError', () => {
  it('lists the missing flags', () => {
    const err = new MissingFlagsError(['--name', '--image']);
    expect(err.flags).toEqual(['--name', '--image']);
    expect(err.message).toContain('--name, --image');
    expect(err.name).toBe('MissingFlagsError');
  });

  it('says "in non-interactive mode" by default: a person at a terminal would have been asked', () => {
    expect(new MissingFlagsError(['--name']).message).toBe('Missing required flag in non-interactive mode: --name');
    expect(new MissingFlagsError(['--name', '--image']).message)
      .toBe('Missing required flags in non-interactive mode: --name, --image');
  });

  it('does not say it for a command that never asks', () => {
    const err = new MissingFlagsError(['--key', '--level'], { promptable: false });

    expect(err.message).toBe('Missing required flags: --key, --level');
    expect(new MissingFlagsError(['--key'], { promptable: false }).message).toBe('Missing required flag: --key');
    expect(err.flags).toEqual(['--key', '--level']);
    expect(err.name).toBe('MissingFlagsError');
  });
});

describe('ConfirmationRequiredError', () => {
  it('mentions --force', () => {
    const err = new ConfirmationRequiredError('VPS vps-1');
    expect(err.message).toContain('--force');
    expect(err.name).toBe('ConfirmationRequiredError');
  });

  it('keeps its standard wording when only the thing to confirm is named', () => {
    expect(new ConfirmationRequiredError('VPS vps-1').message)
      .toBe('Refusing to proceed with VPS vps-1 without --force in non-interactive mode.');
  });

  it('takes the reason in place of "non-interactive mode" when that is not why nothing can be asked', () => {
    const err = new ConfirmationRequiredError('replacing the statements of bucket b', 'the statements come from the standard input. Add --yes.');

    expect(err.message).toBe('Refusing to proceed with replacing the statements of bucket b: the statements come from the standard input. Add --yes.');
    expect(err.message).not.toContain('non-interactive');
    expect(err.name).toBe('ConfirmationRequiredError');
  });
});

describe('ResourceNotFoundError', () => {
  it('has correct message and name', () => {
    const err = new ResourceNotFoundError("VPS 'nonexistent' not found.");
    expect(err.message).toBe("VPS 'nonexistent' not found.");
    expect(err.name).toBe('ResourceNotFoundError');
    expect(err).toBeInstanceOf(Error);
  });
});
