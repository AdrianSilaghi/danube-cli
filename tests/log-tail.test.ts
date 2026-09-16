import { describe, it, expect, vi } from 'vitest';
import { diffLogTail, streamNewLogs } from '../src/lib/log-tail.js';
import type { LogTailState } from '../src/lib/log-tail.js';
import type { ApiClient } from '../src/lib/api-client.js';

describe('diffLogTail', () => {
  it('returns the full text on the first call', () => {
    const state: LogTailState = { printed: '' };

    const result = diffLogTail(state, 'line1\n');

    expect(result).toEqual({ fresh: 'line1\n', moved: false });
    expect(state.printed).toBe('line1\n');
  });

  it('returns only the new suffix when the text grew', () => {
    const state: LogTailState = { printed: 'line1\n' };

    const result = diffLogTail(state, 'line1\nline2\n');

    expect(result).toEqual({ fresh: 'line2\n', moved: false });
  });

  it('returns nothing new when the text is unchanged', () => {
    const state: LogTailState = { printed: 'line1\n' };

    const result = diffLogTail(state, 'line1\n');

    expect(result).toEqual({ fresh: '', moved: false });
  });

  it('flags a moved window when the text no longer starts with what was printed', () => {
    const state: LogTailState = { printed: 'line1\nline2\n' };

    const result = diffLogTail(state, 'line3\nline4\n');

    expect(result).toEqual({ fresh: 'line3\nline4\n', moved: true });
  });

  it('updates state.printed to the latest text even when moved', () => {
    const state: LogTailState = { printed: 'old\n' };

    diffLogTail(state, 'new\n');

    expect(state.printed).toBe('new\n');
  });
});

describe('streamNewLogs', () => {
  it('writes only the fresh text', async () => {
    const get = vi.fn().mockResolvedValue({ data: { logs: 'hello\n' } });
    const api = { get } as unknown as ApiClient;
    const state: LogTailState = { printed: '' };
    const writes: string[] = [];

    await streamNewLogs(api, '/some/path', state, (t) => writes.push(t));

    expect(get).toHaveBeenCalledWith('/some/path');
    expect(writes).toEqual(['hello\n']);
  });

  it('writes a moved marker before the text when the tail window advanced', async () => {
    const get = vi.fn().mockResolvedValue({ data: { logs: 'brand new tail\n' } });
    const api = { get } as unknown as ApiClient;
    const state: LogTailState = { printed: 'something completely different\n' };
    const writes: string[] = [];

    await streamNewLogs(api, '/some/path', state, (t) => writes.push(t));

    expect(writes[0]).toContain('…');
    expect(writes[1]).toBe('brand new tail\n');
  });

  it('writes nothing when there is no new text', async () => {
    const get = vi.fn().mockResolvedValue({ data: { logs: 'same\n' } });
    const api = { get } as unknown as ApiClient;
    const state: LogTailState = { printed: 'same\n' };
    const writes: string[] = [];

    await streamNewLogs(api, '/some/path', state, (t) => writes.push(t));

    expect(writes).toEqual([]);
  });

  it('sanitizes the fresh text before writing', async () => {
    const get = vi.fn().mockResolvedValue({ data: { logs: '[31mred[0m\n' } });
    const api = { get } as unknown as ApiClient;
    const state: LogTailState = { printed: '' };
    const writes: string[] = [];

    await streamNewLogs(api, '/some/path', state, (t) => writes.push(t));

    expect(writes.join('')).toBe('red\n');
  });

  it('swallows a fetch failure without throwing', async () => {
    const get = vi.fn().mockRejectedValue(new Error('network blip'));
    const api = { get } as unknown as ApiClient;
    const state: LogTailState = { printed: '' };
    const writes: string[] = [];

    await expect(streamNewLogs(api, '/some/path', state, (t) => writes.push(t))).resolves.toBeUndefined();
    expect(writes).toEqual([]);
  });
});
