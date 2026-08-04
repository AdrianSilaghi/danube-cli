import { getApiBase, readConfig, getToken, getTeamId } from './config.js';
import { ApiError, NotAuthenticatedError } from './errors.js';
import { getProjectOverride } from './project-context.js';
import { getCurrentVersion } from './version.js';

export class ApiClient {
  private token: string;
  private baseUrl: string;
  private teamId: number | null;

  constructor(token: string, baseUrl?: string, teamId?: number | null) {
    this.token = token;
    this.baseUrl = baseUrl || getApiBase();
    this.teamId = teamId ?? null;
  }

  static async create(): Promise<ApiClient> {
    const config = await readConfig();
    const token = getToken(config);
    if (!token) {
      throw new NotAuthenticatedError();
    }
    // An explicit --project on this invocation outranks DANUBE_TEAM_ID and the
    // saved selection. It scopes the actual request via X-Team-Id rather than
    // being passed as a body field the server is free to ignore.
    //
    // Project-locked tokens stay server-enforced: a header the token is not
    // permitted to use is rejected upstream, never silently honoured here.
    const teamId = getProjectOverride() ?? getTeamId(config);

    return new ApiClient(token, config?.apiBase, teamId);
  }

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs: number = 30_000): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Authorization': `Bearer ${this.token}`,
      'User-Agent': `DanubeCLI/${getCurrentVersion()}`,
    };

    if (this.teamId) {
      headers['X-Team-Id'] = String(this.teamId);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const init: RequestInit = { method, headers, signal: controller.signal };

    if (body !== undefined) {
      if (body instanceof FormData) {
        init.body = body;
      } else {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
    }

    try {
      const res = await fetch(url, init);

      if (res.status === 204) {
        return undefined as T;
      }

      const json = await res.json().catch(() => null);

      if (!res.ok) {
        if (res.status === 401) {
          throw new NotAuthenticatedError();
        }
        // Newer endpoints answer with a {success,data,error,meta} envelope, in
        // which `error` is an OBJECT carrying the failure code and whether a
        // retry can help. Stringifying it would throw that away and print
        // "[object Object]" as the message; older endpoints still send a plain
        // string, so both shapes are handled.
        const envelopeError = json?.error;
        const structured = envelopeError && typeof envelopeError === 'object' ? envelopeError : undefined;

        const message =
          json?.message ||
          structured?.message ||
          (typeof envelopeError === 'string' ? envelopeError : undefined) ||
          `Request failed with status ${res.status}`;

        throw new ApiError(res.status, message, json?.errors, structured);
      }

      return json as T;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(`Request timed out after ${timeoutMs}ms: ${method} ${path}`);
      }
      if (err instanceof TypeError && err.message === 'fetch failed') {
        const cause = (err as { cause?: { code?: string; message?: string } }).cause;
        const detail = cause?.code ?? cause?.message ?? 'network error';
        throw new Error(`Could not reach ${method} ${url} (${detail}). Check your connection and DANUBE_API_BASE.`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  async upload<T>(path: string, file: Uint8Array, filename: string): Promise<T> {
    const formData = new FormData();
    formData.append('file', new Blob([file as BlobPart]), filename);
    const uploadTimeout = Math.max(120_000, file.length / 50);
    return this.request<T>('POST', path, formData, uploadTimeout);
  }
}
