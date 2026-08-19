import { describe, it, expect } from 'vitest';
import { formatCores, formatBytesBinary } from '../src/lib/units.js';

describe('formatCores', () => {
  it('renders millicores below one core', () => {
    expect(formatCores(0.25)).toBe('250m');
    expect(formatCores(0.005)).toBe('5m');
    expect(formatCores(0)).toBe('0m');
  });

  it('renders plain cores at or above one, trailing zeros trimmed', () => {
    expect(formatCores(1)).toBe('1');
    expect(formatCores(1.25)).toBe('1.25');
    expect(formatCores(1.5)).toBe('1.5');
    expect(formatCores(2)).toBe('2');
  });

  it('refuses non-finite and negative readings', () => {
    expect(formatCores(Number.NaN)).toBe('-');
    expect(formatCores(Number.POSITIVE_INFINITY)).toBe('-');
    expect(formatCores(-0.5)).toBe('-');
  });
});

describe('formatBytesBinary', () => {
  it('renders bytes below 1 KiB as-is', () => {
    expect(formatBytesBinary(0)).toBe('0 B');
    expect(formatBytesBinary(512)).toBe('512 B');
    expect(formatBytesBinary(1023)).toBe('1023 B');
  });

  it('renders binary units with trailing zeros trimmed', () => {
    expect(formatBytesBinary(1024)).toBe('1 KiB');
    expect(formatBytesBinary(1536)).toBe('1.5 KiB');
    expect(formatBytesBinary(1048576)).toBe('1 MiB');
    // The reading that motivated binary units: 268435456 bytes IS the 256 in
    // a 512Mi limit.
    expect(formatBytesBinary(268435456)).toBe('256 MiB');
    expect(formatBytesBinary(1073741824)).toBe('1 GiB');
    expect(formatBytesBinary(5.5 * 1024 ** 3)).toBe('5.5 GiB');
    expect(formatBytesBinary(1024 ** 4)).toBe('1 TiB');
  });

  it('caps at TiB rather than inventing units', () => {
    expect(formatBytesBinary(1024 ** 5)).toBe('1024 TiB');
  });

  it('refuses non-finite and negative readings', () => {
    expect(formatBytesBinary(Number.NaN)).toBe('-');
    expect(formatBytesBinary(-1)).toBe('-');
  });
});
