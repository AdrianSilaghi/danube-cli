import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import ignore from 'ignore';
import { create as tarCreate } from 'tar';

async function collectFiles(dir: string, ig: ReturnType<typeof ignore>, base: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(base, fullPath);

    if (ig.ignores(relPath)) continue;

    if (entry.isDirectory()) {
      // Also check if directory itself is ignored (with trailing slash)
      if (ig.ignores(relPath + '/')) continue;
      files.push(...await collectFiles(fullPath, ig, base));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(relPath);
    }
  }

  return files;
}

export async function packageDirectory(dir: string, extraIgnore?: string[]): Promise<{ buffer: Buffer; fileCount: number }> {
  const ig = ignore();

  // Always ignore these
  ig.add(['.git', 'node_modules', '.danube']);

  // Read .gitignore
  try {
    const gitignore = await readFile(join(dir, '.gitignore'), 'utf-8');
    ig.add(gitignore);
  } catch {
    // No .gitignore
  }

  // Read .daubeignore
  try {
    const daubeignore = await readFile(join(dir, '.daubeignore'), 'utf-8');
    ig.add(daubeignore);
  } catch {
    // No .daubeignore
  }

  // Extra ignore patterns from danube.json
  if (extraIgnore?.length) {
    ig.add(extraIgnore);
  }

  const files = await collectFiles(dir, ig, dir);

  if (files.length === 0) {
    throw new Error('No files to deploy. Check your output directory and ignore patterns.');
  }

  // Create tar.gz as buffer
  const chunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    const stream = tarCreate(
      { gzip: true, cwd: dir },
      files,
    );

    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  return {
    buffer: Buffer.concat(chunks),
    fileCount: files.length,
  };
}

export async function getDirectorySize(dir: string): Promise<number> {
  let size = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isFile()) {
      const s = await stat(fullPath);
      size += s.size;
    } else if (entry.isDirectory()) {
      size += await getDirectorySize(fullPath);
    }
  }
  return size;
}
