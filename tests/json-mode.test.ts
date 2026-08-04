import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { jsonOutput, jsonEnvelope, jsonError } from '../src/lib/json-mode.js';

describe('the JSON envelope', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const printed = () => JSON.parse(logSpy.mock.calls.at(-1)![0] as string);

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('wraps a result so every command answers the same question', () => {
    jsonOutput({ id: 'abc', name: 'my-api' });

    expect(printed()).toEqual({
      success: true,
      data: { id: 'abc', name: 'my-api' },
      error: null,
      meta: {},
    });
  });

  it('counts a list without the caller having to', () => {
    jsonOutput([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const payload = printed();
    expect(payload.data).toHaveLength(3);
    expect(payload.meta).toEqual({ count: 3 });
  });

  it('reports an empty list as a success with zero items, not as an absence', () => {
    jsonOutput([]);

    expect(printed()).toEqual({ success: true, data: [], error: null, meta: { count: 0 } });
  });

  it('puts a failure in the same envelope, with no partial data to mistake for a result', () => {
    jsonError({ code: 'not_found', message: "VPS 'x' not found." });

    expect(printed()).toEqual({
      success: false,
      data: null,
      error: { code: 'not_found', message: "VPS 'x' not found." },
      meta: {},
    });
  });

  it('sends errors to stdout, where the results are', () => {
    // Previously errors went to stderr, so a caller capturing only stdout got
    // an empty string on failure and had to infer the reason from the exit
    // code alone.
    jsonError({ code: 'error', message: 'boom' });

    expect(logSpy).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('derives success from the presence of an error, not from a caller-set flag', () => {
    jsonEnvelope({ partial: true }, { error: { code: 'x' } });
    expect(printed().success).toBe(false);

    jsonEnvelope({ ok: true });
    expect(printed().success).toBe(true);
  });

  it('keeps meta an object when empty, never an array', () => {
    // A client typing meta as a map breaks on the one response that happens to
    // have nothing in it.
    jsonEnvelope({ ok: true });

    const { meta } = printed();
    expect(Array.isArray(meta)).toBe(false);
    expect(meta).toEqual({});
  });

  it('emits exactly one parseable document per invocation', () => {
    jsonOutput({ a: 1 });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(() => JSON.parse(logSpy.mock.calls[0]![0] as string)).not.toThrow();
  });
});
