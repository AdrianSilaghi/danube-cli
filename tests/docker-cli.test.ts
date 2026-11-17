import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

const { runDocker } = await import('../src/lib/docker-cli.js');

const fakeChild = () => Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });

describe('runDocker', () => {
  it('writes the input to docker standard input and collects its output', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    const input: string[] = [];
    child.stdin.on('data', (c: Buffer) => input.push(String(c)));

    const pending = runDocker(['login', 'h', '--password-stdin'], 'the-token');
    child.stdout.write('Login Succeeded');
    child.stderr.write('warning');
    child.stdin.emit('error', new Error('EPIPE'));
    child.emit('close', 0);

    expect(await pending).toEqual({ code: 0, stdout: 'Login Succeeded', stderr: 'warning', timedOut: false });
    expect(input.join('')).toBe('the-token');
    expect(spawnMock).toHaveBeenCalledWith('docker', ['login', 'h', '--password-stdin'], { stdio: ['pipe', 'pipe', 'pipe'] });
  });

  it('kills a docker that does not finish in time and says so', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(fakeChild(), { kill: vi.fn() });
      spawnMock.mockReturnValueOnce(child);

      const pending = runDocker(['login'], 'tok', { timeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(child.kill).toHaveBeenCalled();
      child.emit('close', null);

      expect(await pending).toMatchObject({ code: null, timedOut: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the timer when docker cannot be started', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(fakeChild(), { kill: vi.fn() });
      spawnMock.mockReturnValueOnce(child);

      const pending = runDocker(['--version'], undefined, { timeoutMs: 1_000 });
      child.emit('error', new Error('spawn docker ENOENT'));
      await expect(pending).rejects.toThrow('ENOENT');
      await vi.advanceTimersByTimeAsync(5_000);

      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects when docker cannot be started', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);

    const pending = runDocker(['--version']);
    child.emit('error', new Error('spawn docker ENOENT'));

    await expect(pending).rejects.toThrow('ENOENT');
  });
});
