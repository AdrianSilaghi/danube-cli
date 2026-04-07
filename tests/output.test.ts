import { describe, it, expect } from 'vitest';
import chalk from 'chalk';
import { formatTable, statusColor, formatBytes, formatDate } from '../src/lib/output.js';

describe('output', () => {
  describe('formatTable', () => {
    it('formats a simple table', () => {
      const result = formatTable(['NAME', 'AGE'], [['Alice', '30'], ['Bob', '25']]);
      const lines = result.split('\n');
      expect(lines).toHaveLength(4); // header + separator + 2 rows
      expect(lines[0]).toContain('NAME');
      expect(lines[0]).toContain('AGE');
      expect(lines[2]).toContain('Alice');
      expect(lines[3]).toContain('Bob');
    });

    it('pads columns to widest value', () => {
      const result = formatTable(['A', 'B'], [['longvalue', 'x']]);
      const lines = result.split('\n');
      // header 'A' should be padded to width of 'longvalue' (9)
      expect(lines[0]!.startsWith('A')).toBe(true);
      expect(lines[2]).toContain('longvalue');
    });

    it('handles empty cell gracefully', () => {
      const result = formatTable(['A', 'B'], [['val']]);
      expect(result).toContain('val');
    });

    it('handles empty rows', () => {
      const result = formatTable(['A', 'B'], []);
      const lines = result.split('\n');
      expect(lines).toHaveLength(2); // header + separator only
    });

    it('aligns columns correctly with ANSI-colored cells', () => {
      const colored = chalk.green('live');
      const result = formatTable(
        ['NAME', 'STATUS', 'REGION'],
        [
          ['my-site', colored, 'fsn1'],
          ['other-app', 'stopped', 'hel1'],
        ],
      );
      const lines = result.split('\n');
      // Separator dashes should align with header widths (no ANSI inflation)
      const sepParts = lines[1]!.split('  ');
      expect(sepParts[1]!.length).toBe('STATUS'.length < 'stopped'.length ? 'stopped'.length : 'STATUS'.length);
      // The non-colored row should have proper padding too
      const stoppedRow = lines[3]!;
      // 'other-app' and 'stopped' should be separated by exactly 2 spaces after padding
      expect(stoppedRow).toContain('other-app  stopped  hel1');
    });
  });

  describe('statusColor', () => {
    it('colors live green', () => {
      expect(statusColor('live')).toBe(chalk.green('live'));
    });

    it('colors active green', () => {
      expect(statusColor('active')).toBe(chalk.green('active'));
    });

    it('colors verified green', () => {
      expect(statusColor('verified')).toBe(chalk.green('verified'));
    });

    it('colors pending yellow', () => {
      expect(statusColor('pending')).toBe(chalk.yellow('pending'));
    });

    it('colors uploading yellow', () => {
      expect(statusColor('uploading')).toBe(chalk.yellow('uploading'));
    });

    it('colors processing yellow', () => {
      expect(statusColor('processing')).toBe(chalk.yellow('processing'));
    });

    it('colors deploying yellow', () => {
      expect(statusColor('deploying')).toBe(chalk.yellow('deploying'));
    });

    it('colors building_image yellow', () => {
      expect(statusColor('building_image')).toBe(chalk.yellow('building_image'));
    });

    it('colors pushing yellow', () => {
      expect(statusColor('pushing')).toBe(chalk.yellow('pushing'));
    });

    it('colors cloning yellow', () => {
      expect(statusColor('cloning')).toBe(chalk.yellow('cloning'));
    });

    it('colors failed red', () => {
      expect(statusColor('failed')).toBe(chalk.red('failed'));
    });

    it('returns unknown status as-is', () => {
      expect(statusColor('unknown')).toBe('unknown');
    });
  });

  describe('formatBytes', () => {
    it('formats 0 bytes', () => {
      expect(formatBytes(0)).toBe('0 B');
    });

    it('formats bytes', () => {
      expect(formatBytes(500)).toBe('500 B');
    });

    it('formats kilobytes', () => {
      expect(formatBytes(1024)).toBe('1.0 KB');
    });

    it('formats megabytes', () => {
      expect(formatBytes(1048576)).toBe('1.0 MB');
    });

    it('formats gigabytes', () => {
      expect(formatBytes(1073741824)).toBe('1.0 GB');
    });

    it('formats terabytes', () => {
      expect(formatBytes(1099511627776)).toBe('1.0 TB');
    });

    it('clamps to TB for very large values', () => {
      expect(formatBytes(1099511627776 * 1024)).toBe('1024.0 TB');
    });
  });

  describe('formatDate', () => {
    it('formats ISO date string', () => {
      const result = formatDate('2024-01-15T10:30:00Z');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
