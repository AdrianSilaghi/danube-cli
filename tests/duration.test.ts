import { describe, it, expect } from 'vitest';
import { parseDuration, parseDurationSeconds } from '../src/lib/duration.js';
import { UsageError } from '../src/lib/errors.js';

describe('parseDuration', () => {
  it('reads the suffixes a caller would actually type', () => {
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('1500ms')).toBe(1500);
  });

  it('treats a bare number as milliseconds, matching the existing --timeout flags', () => {
    // Two spellings of the same flag must not mean different things.
    expect(parseDuration('5000')).toBe(5000);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseDuration('  30m ')).toBe(1_800_000);
  });

  it('rejects an unrecognised unit instead of falling back to a default', () => {
    // Silently defaulting is how a caller comes to believe it waited half an
    // hour when it waited ten seconds.
    expect(() => parseDuration('30x')).toThrow(UsageError);
    expect(() => parseDuration('soon')).toThrow(UsageError);
    expect(() => parseDuration('')).toThrow(UsageError);
  });

  it('rejects zero and negative durations', () => {
    expect(() => parseDuration('0')).toThrow(UsageError);
    expect(() => parseDuration('-5m')).toThrow(UsageError);
  });

  it('names the accepted forms in the error', () => {
    expect(() => parseDuration('30x')).toThrow(/90s, 30m, 2h/);
  });

  it('accepts zero with { allowZero: true }, for a field where zero is meaningful', () => {
    expect(parseDuration('0', { allowZero: true })).toBe(0);
  });

  it('still rejects a negative value even with allowZero', () => {
    // The regex only matches \d+, so a leading '-' fails to match at all
    // rather than parsing as a negative number.
    expect(() => parseDuration('-5m', { allowZero: true })).toThrow(UsageError);
  });
});

describe('parseDurationSeconds', () => {
  it('reads the suffixes a caller would actually type, in seconds', () => {
    expect(parseDurationSeconds('30s')).toBe(30);
    expect(parseDurationSeconds('5m')).toBe(300);
    expect(parseDurationSeconds('1h')).toBe(3600);
  });

  it('accepts zero, unlike parseDuration()', () => {
    expect(parseDurationSeconds('0')).toBe(0);
  });

  it('rejects a duration that is not a whole number of seconds instead of rounding it', () => {
    expect(() => parseDurationSeconds('500ms')).toThrow(UsageError);
    expect(() => parseDurationSeconds('500ms')).toThrow(/whole number of seconds/);
  });

  it('rejects an unrecognised unit', () => {
    expect(() => parseDurationSeconds('30x')).toThrow(UsageError);
  });
});
