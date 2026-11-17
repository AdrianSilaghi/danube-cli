import { spawn } from 'node:child_process';

export interface DockerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run `docker <args>`. `stdin` is written to the child's standard input, which is
 * how a secret reaches it without ever being an argument (visible in the process
 * list) or an environment variable. Output is collected, not echoed, so a caller
 * in `--json` mode keeps its stdout clean. Rejects when docker cannot be started
 * (`ENOENT` when it is not installed).
 */
export function runDocker(args: string[], stdin?: string): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    // Docker may exit before reading its input (a failed login); that is reported by its exit code.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}
