let _jsonMode = false;

export function setJsonMode(enabled: boolean): void {
  _jsonMode = enabled;
}

export function isJsonMode(): boolean {
  return _jsonMode;
}

/**
 * The envelope every `--json` invocation emits, success or failure.
 */
export interface JsonEnvelope {
  success: boolean;
  data: unknown;
  error: JsonErrorBody | null;
  meta: Record<string, unknown>;
}

export interface JsonErrorBody {
  code: string;
  message?: string;
  [k: string]: unknown;
}

/**
 * One writer, one destination.
 *
 * Everything goes to stdout — including errors, which used to go to stderr.
 * A caller that captured only stdout got an empty string on failure and had to
 * infer the reason from the exit code; now there is exactly one place to look
 * and `success` always answers the question.
 */
function emit(payload: JsonEnvelope): void {
  console.log(JSON.stringify(payload, null, 2));
}

/**
 * Emit a successful result.
 *
 * Wrapping happens here rather than at the ~100 call sites, so a command
 * cannot forget to do it and the shape cannot drift between commands.
 */
export function jsonOutput(data: unknown): void {
  emit({
    success: true,
    data,
    error: null,
    // A list's length is worth stating outright: it is the first thing a
    // caller checks, and counting client-side invites off-by-one paging bugs.
    meta: Array.isArray(data) ? { count: data.length } : {},
  });
}

/**
 * Emit a result with explicit metadata, or a structured failure.
 */
export function jsonEnvelope(
  data: unknown,
  opts: { error?: JsonErrorBody | null; meta?: Record<string, unknown> } = {},
): void {
  const error = opts.error ?? null;
  emit({ success: error === null, data, error, meta: opts.meta ?? {} });
}

/**
 * Emit a failure. `data` is null: there is no partial result to salvage.
 */
export function jsonError(error: JsonErrorBody): void {
  emit({ success: false, data: null, error, meta: {} });
}
