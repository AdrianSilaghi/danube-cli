import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { packageDirectory, getDirectorySize } from '../src/lib/packager.js';

describe('packager', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `danube-packager-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('packageDirectory', () => {
    it('packages files into zip', async () => {
      await writeFile(join(testDir, 'index.html'), '<h1>Hello</h1>');
      await writeFile(join(testDir, 'style.css'), 'body {}');

      const { buffer, fileCount } = await packageDirectory(testDir);
      expect(fileCount).toBe(2);
      expect(buffer.length).toBeGreaterThan(0);
      // Check it's a ZIP (magic bytes 50 4b)
      expect(buffer[0]).toBe(0x50);
      expect(buffer[1]).toBe(0x4b);
    });

    it('respects .gitignore', async () => {
      await writeFile(join(testDir, '.gitignore'), 'ignored.txt\n');
      await writeFile(join(testDir, 'index.html'), '<h1>Hello</h1>');
      await writeFile(join(testDir, 'ignored.txt'), 'secret');

      const { fileCount } = await packageDirectory(testDir);
      // .gitignore + index.html (ignored.txt is excluded)
      expect(fileCount).toBe(2);
    });

    it('respects .daubeignore', async () => {
      await writeFile(join(testDir, '.daubeignore'), '*.log\n');
      await writeFile(join(testDir, 'index.html'), '<h1>Hello</h1>');
      await writeFile(join(testDir, 'debug.log'), 'log');

      const { fileCount } = await packageDirectory(testDir);
      // .daubeignore + index.html (debug.log is excluded)
      expect(fileCount).toBe(2);
    });

    it('respects extra ignore patterns', async () => {
      await writeFile(join(testDir, 'index.html'), '<h1>Hello</h1>');
      await writeFile(join(testDir, 'temp.bak'), 'backup');

      const { fileCount } = await packageDirectory(testDir, ['*.bak']);
      expect(fileCount).toBe(1);
    });

    it('always ignores .git, node_modules, .danube', async () => {
      await mkdir(join(testDir, '.git'), { recursive: true });
      await writeFile(join(testDir, '.git', 'config'), 'gitconfig');
      await mkdir(join(testDir, 'node_modules'), { recursive: true });
      await writeFile(join(testDir, 'node_modules', 'pkg.json'), '{}');
      await mkdir(join(testDir, '.danube'), { recursive: true });
      await writeFile(join(testDir, '.danube', 'project.json'), '{}');
      await writeFile(join(testDir, 'index.html'), '<h1>Hello</h1>');

      const { fileCount } = await packageDirectory(testDir);
      expect(fileCount).toBe(1);
    });

    it('throws when no files to deploy', async () => {
      // Empty directory — all default-ignored
      await mkdir(join(testDir, '.git'), { recursive: true });
      await writeFile(join(testDir, '.git', 'HEAD'), 'ref');

      await expect(packageDirectory(testDir)).rejects.toThrow('No files to deploy');
    });

    it('includes files in subdirectories', async () => {
      await mkdir(join(testDir, 'sub'), { recursive: true });
      await writeFile(join(testDir, 'index.html'), '<h1>Hello</h1>');
      await writeFile(join(testDir, 'sub', 'page.html'), '<h1>Page</h1>');

      const { fileCount } = await packageDirectory(testDir);
      expect(fileCount).toBe(2);
    });

    it('ignores subdirectories matching ignore patterns', async () => {
      await mkdir(join(testDir, 'build'), { recursive: true });
      await writeFile(join(testDir, 'build', 'output.js'), 'js');
      await writeFile(join(testDir, 'index.html'), '<h1>Hello</h1>');

      const { fileCount } = await packageDirectory(testDir, ['build']);
      expect(fileCount).toBe(1);
    });

    it('ignores directories matching trailing-slash patterns', async () => {
      // Pattern 'logs/' only matches directories, not files named 'logs'
      await mkdir(join(testDir, 'logs'), { recursive: true });
      await writeFile(join(testDir, 'logs', 'app.log'), 'log data');
      await writeFile(join(testDir, 'index.html'), '<h1>Hello</h1>');

      const { fileCount } = await packageDirectory(testDir, ['logs/']);
      expect(fileCount).toBe(1);
    });

    it('includes symlinks', async () => {
      await writeFile(join(testDir, 'real.txt'), 'content');
      await symlink(join(testDir, 'real.txt'), join(testDir, 'link.txt'));

      const { fileCount } = await packageDirectory(testDir);
      expect(fileCount).toBe(2);
    });

    it('works without .gitignore or .daubeignore', async () => {
      await writeFile(join(testDir, 'index.html'), '<h1>Hello</h1>');

      const { buffer, fileCount } = await packageDirectory(testDir);
      expect(fileCount).toBe(1);
      expect(buffer.length).toBeGreaterThan(0);
    });

    it('works with empty extra ignore array', async () => {
      await writeFile(join(testDir, 'index.html'), '<h1>Hello</h1>');

      const { fileCount } = await packageDirectory(testDir, []);
      expect(fileCount).toBe(1);
    });

    it('skips entries that are not files, symlinks, or directories', async () => {
      await writeFile(join(testDir, 'index.html'), '<h1>Hello</h1>');
      // Create a FIFO (named pipe) — neither file nor directory nor symlink
      execSync(`mkfifo "${join(testDir, 'my.pipe')}"`);

      const { fileCount } = await packageDirectory(testDir);
      // Only index.html, FIFO is skipped
      expect(fileCount).toBe(1);
    });
  });

  describe('getDirectorySize', () => {
    it('returns 0 for empty directory', async () => {
      expect(await getDirectorySize(testDir)).toBe(0);
    });

    it('sums file sizes', async () => {
      await writeFile(join(testDir, 'a.txt'), 'hello'); // 5 bytes
      await writeFile(join(testDir, 'b.txt'), 'world!'); // 6 bytes

      const size = await getDirectorySize(testDir);
      expect(size).toBe(11);
    });

    it('includes subdirectory sizes', async () => {
      await mkdir(join(testDir, 'sub'), { recursive: true });
      await writeFile(join(testDir, 'a.txt'), 'hi'); // 2 bytes
      await writeFile(join(testDir, 'sub', 'b.txt'), 'yo'); // 2 bytes

      const size = await getDirectorySize(testDir);
      expect(size).toBe(4);
    });

    it('ignores entries that are not files or directories', async () => {
      await writeFile(join(testDir, 'a.txt'), 'hi'); // 2 bytes
      // Create a broken symlink (target doesn't exist)
      await symlink(join(testDir, 'nonexistent'), join(testDir, 'broken-link'));

      const size = await getDirectorySize(testDir);
      // Only counts the regular file, broken symlink is neither file nor dir
      expect(size).toBe(2);
    });
  });
});
