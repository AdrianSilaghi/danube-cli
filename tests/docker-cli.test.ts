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

    expect(await pending).toEqual({ code: 0, stdout: 'Login Succeeded', stderr: 'warning' });
    expect(input.join('')).toBe('the-token');
    expect(spawnMock).toHaveBeenCalledWith('docker', ['login', 'h', '--password-stdin'], { stdio: ['pipe', 'pipe', 'pipe'] });
  });

  it('rejects when docker cannot be started', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);

    const pending = runDocker(['--version']);
    child.emit('error', new Error('spawn docker ENOENT'));

    await expect(pending).rejects.toThrow('ENOENT');
  });
});
