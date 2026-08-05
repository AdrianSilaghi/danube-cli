import { UsageError } from './errors.js';

/**
 * Shared handling for log-shaped text and time windows.
 *
 * Extracted from the rapids diagnostics commands when every other product
 * gained the same endpoints. Two copies of `sanitize()` would not be a style
 * problem but a security one: the weaker copy is the one an attacker reaches,
 * and nobody notices the divergence because both appear to work.
 *
 * Moved verbatim, so the existing tests in tests/project-context.test.ts are
 * the regression gate for the extraction.
 */

/**
 * Translate `1h` / `30m` / `7d` into an absolute ISO timestamp.
 *
 * Absolute times are what the API validates against its retention window, and
 * resolving here means the server never has to guess what "now" meant to a
 * client whose clock may differ.
 */
export function parseSince(value: string): string {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) {
    throw new UsageError(`Invalid --since "${value}". Use a duration like 30m, 6h or 2d.`);
  }

  const amount = Number(match[1]);
  const seconds = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as 's' | 'm' | 'h' | 'd'];

  return new Date(Date.now() - amount * seconds * 1000).toISOString();
}

/**
 * Strip ANSI escapes and other control characters from log text.
 *
 * Log lines are attacker-influenced: whatever a container prints ends up here.
 * Without this, a crafted line can repaint the terminal, hide itself with a
 * carriage return, or emit an OSC sequence — so an operator reading logs
 * cannot trust what they are seeing. Tabs and newlines are kept; everything
 * else in the C0/C1 control range is removed.
 */
export function sanitize(text: string): string {
  return text
    // CSI / ANSI escape sequences (colours, cursor movement, screen clears).
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    // OSC sequences (window title, hyperlinks), terminated by BEL or ST.
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    // Any remaining single-character escapes.
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b[@-_]/g, '')
    // Remaining C0/C1 controls, keeping tab (09) and newline (0A).
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}
