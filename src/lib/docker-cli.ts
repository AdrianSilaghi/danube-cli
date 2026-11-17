import { spawn } from 'node:child_process';

export interface DockerResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when `timeoutMs` ran out and the child was killed. */
  timedOut: boolean;
}

/**
 * Run `docker <args>`. `stdin` is written to the child's standard input, which is
 * how a secret reaches it without ever being an argument (visible in the process
 * list) or an environment variable. Output is collected, not echoed, so a caller
 * in `--json` mode keeps its stdout clean. Rejects when docker cannot be started
 * (`ENOENT` when it is not installed).
 *
 * `timeoutMs` kills a docker that does not finish (a daemon that never answers, a
 * keychain prompt nobody sees) and resolves with `timedOut`, so the caller can
 * clean up instead of hanging.
 */
export function runDocker(args: string[], stdin?: string, options: { timeoutMs?: number } = {}): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = options.timeoutMs === undefined
      ? null
      : setTimeout(() => {
        timedOut = true;
        child.kill();
      }, options.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    // Docker may exit before reading its input (a failed login); that is reported by its exit code.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}
