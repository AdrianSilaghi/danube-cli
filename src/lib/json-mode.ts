let _jsonMode = false;

export function setJsonMode(enabled: boolean): void {
  _jsonMode = enabled;
}

export function isJsonMode(): boolean {
  return _jsonMode;
}

export function jsonOutput(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * The single JSON shape every command emits.
 *
 * Registry commands already returned `{success, data, error, meta}` because the
 * API does, while diagnose and apply invented their own top-level structures.
 * An agent had to know which command it was talking to before it could find the
 * payload — which defeats the point of machine-readable output.
 *
 * `meta` is always an object, never an array: a client that types it as a map
 * breaks on the one response that happens to have nothing in it.
 */
export function jsonEnvelope(
  data: unknown,
  opts: { error?: { code: string; message?: string; retryable?: boolean; hint?: string } | null; meta?: Record<string, unknown> } = {},
): void {
  const error = opts.error ?? null;
  jsonOutput({ success: error === null, data, error, meta: opts.meta ?? {} });
}

export function jsonError(error: { code: string; message: string; [k: string]: unknown }): void {
  console.error(JSON.stringify(error));
}
