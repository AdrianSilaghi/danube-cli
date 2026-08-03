import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveProjectFlag,
  parseProjectId,
  setProjectOverride,
  getProjectOverride,
} from '../src/lib/project-context.js';
import { resolveAlias } from '../src/lib/flag-alias.js';
import { sanitize, parseSince } from '../src/commands/serverless/diagnostics.js';
import { UsageError } from '../src/lib/errors.js';

describe('project context', () => {
  beforeEach(() => {
    setProjectOverride(null);
  });

  it('accepts the canonical --project flag', () => {
    expect(resolveProjectFlag({ project: '42' })).toBe(42);
  });

  it('accepts --team as a compatibility alias', () => {
    expect(resolveProjectFlag({ team: '42' })).toBe(42);
  });

  it('accepts both when they agree', () => {
    expect(resolveProjectFlag({ project: '42', team: '42' })).toBe(42);
  });

  it('rejects conflicting selectors rather than guessing', () => {
    // Silently preferring one would point automation at the wrong project
    // with no signal that it happened.
    expect(() => resolveProjectFlag({ project: '42', team: '7' })).toThrow(UsageError);
  });

  it('returns null when no selector is supplied, deferring to env and config', () => {
    expect(resolveProjectFlag({})).toBeNull();
  });

  it.each(['0', '-1', 'abc', '12abc', '4.5', '', ' '])(
    'rejects %o as a project id',
    (value) => {
      expect(() => parseProjectId(value)).toThrow(UsageError);
    },
  );

  it('does not coerce a partially numeric id', () => {
    // parseInt('12abc') is 12 — a silent, wrong answer.
    expect(() => parseProjectId('12abc')).toThrow(UsageError);
  });

  it('holds an override for the current invocation', () => {
    setProjectOverride(99);
    expect(getProjectOverride()).toBe(99);

    setProjectOverride(null);
    expect(getProjectOverride()).toBeNull();
  });
});

describe('flag aliases', () => {
  it('prefers the canonical flag', () => {
    expect(resolveAlias('resource-profile', [
      ['--resource-profile', 'small'],
      ['--plan', undefined],
    ])).toBe('small');
  });

  it('accepts the ergonomic alias', () => {
    expect(resolveAlias('resource-profile', [
      ['--resource-profile', undefined],
      ['--plan', 'medium'],
    ])).toBe('medium');
  });

  it('accepts both when they agree', () => {
    expect(resolveAlias('resource-profile', [
      ['--resource-profile', 'small'],
      ['--plan', 'small'],
    ])).toBe('small');
  });

  it('rejects conflicting aliases', () => {
    // Provisioning the wrong size silently is worse than failing loudly.
    expect(() => resolveAlias('resource-profile', [
      ['--resource-profile', 'small'],
      ['--plan', 'large'],
    ])).toThrow(UsageError);
  });

  it('returns undefined when nothing is supplied', () => {
    expect(resolveAlias('network-stack', [
      ['--network-stack', undefined],
      ['--network', undefined],
    ])).toBeUndefined();
  });
});

describe('log sanitization', () => {
  const ESC = '\u001b';

  it('strips ANSI colour sequences', () => {
    expect(sanitize(`${ESC}[31mred${ESC}[0m`)).toBe('red');
  });

  it('strips cursor movement and screen clears', () => {
    // A crafted log line must not be able to repaint the operator's terminal.
    expect(sanitize(`before${ESC}[2J${ESC}[Hafter`)).toBe('beforeafter');
  });

  it('strips OSC sequences that could retitle the window', () => {
    expect(sanitize(`${ESC}]0;pwned\u0007safe`)).toBe('safe');
  });

  it('strips carriage returns used to overwrite earlier output', () => {
    expect(sanitize('real line\rfake line')).toBe('real linefake line');
  });

  it('keeps tabs and newlines, which are legitimate log content', () => {
    expect(sanitize('a\tb\nc')).toBe('a\tb\nc');
  });

  it('leaves ordinary text untouched', () => {
    expect(sanitize('GET /health 200 12ms')).toBe('GET /health 200 12ms');
  });
});

describe('--since parsing', () => {
  it.each([['30m', 30 * 60], ['6h', 6 * 3600], ['2d', 2 * 86400], ['45s', 45]])(
    'resolves %s to an absolute timestamp',
    (input, seconds) => {
      const before = Date.now();
      const parsed = Date.parse(parseSince(input));

      // Resolved client-side so the server never has to guess what "now"
      // meant to a client whose clock may differ.
      expect(before - parsed).toBeGreaterThanOrEqual(seconds * 1000 - 1000);
      expect(before - parsed).toBeLessThanOrEqual(seconds * 1000 + 1000);
    },
  );

  it.each(['1', 'h', '1w', 'yesterday', '-1h'])('rejects %o', (value) => {
    expect(() => parseSince(value)).toThrow(UsageError);
  });
});
