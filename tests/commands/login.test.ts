import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockWriteConfig = vi.fn();
vi.mock('../../src/lib/config.js', () => ({
  writeConfig: (...args: unknown[]) => mockWriteConfig(...args),
  getApiBase: () => 'https://test.danubedata.ro',
}));

const mockPassword = vi.fn();
vi.mock('@inquirer/prompts', () => ({
  password: (...args: unknown[]) => mockPassword(...args),
}));

const { loginCommand } = await import('../../src/commands/login.js');

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

describe('login command', () => {
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exit = vi.fn().mockImplementation((code: number) => {
      throw new ExitError(code);
    }) as never;
    mockWriteConfig.mockReset();
    mockPassword.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    vi.restoreAllMocks();
  });

  it('logs in with --token flag', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 1, name: 'Test User', email: 'test@example.com' }),
    });

    await loginCommand.parseAsync(['node', 'test', '--token', 'my-token']);

    expect(fetch).toHaveBeenCalledWith('https://test.danubedata.ro/api/user', {
      headers: {
        'Accept': 'application/json',
        'Authorization': 'Bearer my-token',
      },
    });
    expect(mockWriteConfig).toHaveBeenCalledWith({
      token: 'my-token',
      apiBase: 'https://test.danubedata.ro',
    });
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Test User'));
  });

  it('prompts for token when not provided', async () => {
    mockPassword.mockResolvedValue('prompted-token');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 1, name: 'Test', email: 'test@test.com' }),
    });

    await loginCommand.parseAsync(['node', 'test']);

    expect(mockPassword).toHaveBeenCalled();
    expect(mockWriteConfig).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'prompted-token' }),
    );
  });

  it('exits when token is empty', async () => {
    mockPassword.mockResolvedValue('');

    await expect(
      loginCommand.parseAsync(['node', 'test']),
    ).rejects.toThrow(ExitError);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('No token'));
  });

  it('exits on 401 invalid token', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ message: 'Unauthenticated' }),
    });

    await expect(
      loginCommand.parseAsync(['node', 'test', '--token', 'bad-token']),
    ).rejects.toThrow(ExitError);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid token'));
  });

  it('throws ApiError on non-401 error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ message: 'Server error' }),
    });

    await expect(
      loginCommand.parseAsync(['node', 'test', '--token', 'my-token']),
    ).rejects.toThrow('Validation failed with status 500');
  });

  it('exits when fetch fails with network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      loginCommand.parseAsync(['node', 'test', '--token', 'my-token']),
    ).rejects.toThrow(ExitError);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to connect'));
  });

  it('trims whitespace from token', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 1, name: 'Test', email: 'test@test.com' }),
    });

    await loginCommand.parseAsync(['node', 'test', '--token', '  my-token  ']);

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ 'Authorization': 'Bearer my-token' }),
      }),
    );
  });
});
