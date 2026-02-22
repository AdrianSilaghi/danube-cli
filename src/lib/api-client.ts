import { getApiBase, readConfig, getToken } from './config.js';
import { ApiError, NotAuthenticatedError } from './errors.js';

export class ApiClient {
  private token: string;
  private baseUrl: string;

  constructor(token: string, baseUrl?: string) {
    this.token = token;
    this.baseUrl = baseUrl || getApiBase();
  }

  static async create(): Promise<ApiClient> {
    const config = await readConfig();
    const token = getToken(config);
    if (!token) {
      throw new NotAuthenticatedError();
    }
    return new ApiClient(token, config?.apiBase);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Authorization': `Bearer ${this.token}`,
    };

    const init: RequestInit = { method, headers };

    if (body !== undefined) {
      if (body instanceof FormData) {
        init.body = body;
      } else {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
    }

    const res = await fetch(url, init);

    if (res.status === 204) {
      return undefined as T;
    }

    const json = await res.json().catch(() => null);

    if (!res.ok) {
      if (res.status === 401) {
        throw new NotAuthenticatedError();
      }
      const message = json?.message || `Request failed with status ${res.status}`;
      throw new ApiError(res.status, message, json?.errors);
    }

    return json as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  async upload<T>(path: string, file: Uint8Array, filename: string): Promise<T> {
    const formData = new FormData();
    formData.append('archive', new Blob([file as BlobPart]), filename);
    return this.request<T>('POST', path, formData);
  }
}
