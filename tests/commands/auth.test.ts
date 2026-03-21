import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockWriteConfig = vi.fn();
vi.mock('../../src/lib/config.js', () => ({
  writeConfig: (...args: unknown[]) => mockWriteConfig(...args),
  getApiBase: () => 'https://danubedata.ro',
}));

vi.mock('../../src/lib/sleep.js', () => ({
  sleep: () => Promise.resolve(),
}));

vi.mock('node:child_process', () => ({
  exec: vi.fn(),
}));

const { authCommand } = await import('../../src/commands/auth.js');

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

describe('auth command', () => {
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
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    vi.restoreAllMocks();
  });

  it('authenticates successfully via polling', async () => {
    let pollCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/cli/poll')) {
        pollCount++;
        if (pollCount < 2) {
          return Promise.resolve({
            ok: true,
            status: 202,
            json: () => Promise.resolve({ status: 'pending' }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ token: 'test-token' }),
        });
      }
      // GET /api/user
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: 1, name: 'Test User', email: 'test@example.com' }),
      });
    });

    await authCommand.parseAsync(['node', 'test']);

    expect(mockWriteConfig).toHaveBeenCalledWith({
      token: 'test-token',
      apiBase: 'https://danubedata.ro',
    });
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Test User'));
  });

  it('opens browser with correct console URL', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/cli/poll')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ token: 'test-token' }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: 1, name: 'Test', email: 'test@test.com' }),
      });
    });

    await authCommand.parseAsync(['node', 'test']);

    const openingCall = consoleLogSpy.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('Opening browser'),
    );
    expect(openingCall![0]).toContain('console.danubedata.ro/cli/authorize');
  });

  it('polls console subdomain for token', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/cli/poll')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ token: 'test-token' }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: 1, name: 'Test', email: 'test@test.com' }),
      });
    });

    await authCommand.parseAsync(['node', 'test']);

    const pollCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => (call[0] as string).includes('/cli/poll'),
    );
    expect(pollCall![0]).toContain('console.danubedata.ro/cli/poll');
  });

  it('exits with error on invalid token from server', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/cli/poll')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ token: 'bad-token' }),
        });
      }
      // API returns 401
      return Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ message: 'Unauthenticated' }),
      });
    });

    const result = authCommand.parseAsync(['node', 'test']).catch((e: unknown) => e);
    const error = await result;

    expect(error).toBeInstanceOf(ExitError);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('invalid token'));
  });

  it('times out when poll never returns token', async () => {
    // Mock Date.now to simulate timeout
    const realDateNow = Date.now;
    let callCount = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      callCount++;
      // First call is startTime, subsequent calls simulate time passing
      if (callCount <= 1) return 0;
      return 200_000; // Past AUTH_TIMEOUT
    });

    globalThis.fetch = vi.fn().mockImplementation(() => {
      return Promise.resolve({
        ok: true,
        status: 202,
        json: () => Promise.resolve({ status: 'pending' }),
      });
    });

    const result = authCommand.parseAsync(['node', 'test']).catch((e: unknown) => e);
    const error = await result;

    expect(error).toBeInstanceOf(ExitError);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('timed out'));

    Date.now = realDateNow;
  });
});
