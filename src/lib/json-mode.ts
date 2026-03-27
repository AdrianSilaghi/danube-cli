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

export function jsonError(error: { code: string; message: string; errors?: Record<string, string[]> }): void {
  console.error(JSON.stringify(error));
}
