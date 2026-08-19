/**
 * Formatters for Kubernetes-style resource readings.
 *
 * Kept separate from output.ts's decimal-labelled formatBytes: allocations
 * arrive as binary quantities (`512Mi`, `1Gi`), so usage readings printed next
 * to them must use the same binary units or the comparison misleads —
 * 268435456 bytes IS the "256" in a 512Mi limit, and only MiB says so.
 */

/**
 * CPU cores → the notation the allocation column already uses: millicores
 * below one core (`250m`), plain cores at or above (`1.25`).
 */
export function formatCores(cores: number): string {
  if (!Number.isFinite(cores) || cores < 0) return '-';
  if (cores < 1) return `${Math.round(cores * 1000)}m`;
  return trimZeros(cores.toFixed(2));
}

/**
 * Bytes → binary units (KiB/MiB/GiB/TiB), one decimal, trailing zeros
 * trimmed so the common case reads `256 MiB`, not `256.0 MiB`.
 */
export function formatBytesBinary(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 'B';
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${trimZeros(value.toFixed(1))} ${unit}`;
}

function trimZeros(fixed: string): string {
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}
