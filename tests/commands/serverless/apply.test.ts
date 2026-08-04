import { describe, it, expect } from 'vitest';
import { slugify } from '../../../src/commands/serverless/apply.js';

describe('apply slugify', () => {
  it('mirrors the API slug rule', () => {
    expect(slugify('My API')).toBe('my-api');
    expect(slugify('Danube Todo')).toBe('danube-todo');
  });

  it('collapses runs of non-alphanumerics into one hyphen', () => {
    expect(slugify('a  b__c!!d')).toBe('a-b-c-d');
  });

  it('does not emit leading or trailing hyphens', () => {
    // The API regex is ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ — a leading or trailing
    // hyphen is rejected, so producing one would turn a valid name into a 422.
    expect(slugify('  spaced  ')).toBe('spaced');
    expect(slugify('!!weird!!')).toBe('weird');
  });

  it('truncates to the 63-character limit', () => {
    expect(slugify('a'.repeat(100))).toHaveLength(63);
  });
});
