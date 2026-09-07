/**
 * Shared in-memory object store used by the storage stub in tests.
 * Kept in its own module so a vi.mock factory can import it without
 * tripping over hoisting.
 */
export const objects = new Map<string, { body: Buffer; mimeType: string }>();

export function resetStorage(): void {
  objects.clear();
}

/** Simulates tampering so the hash-mismatch path can be exercised. */
export function corruptObject(path: string, replacement: Buffer): void {
  const existing = objects.get(path);
  objects.set(path, { body: replacement, mimeType: existing?.mimeType ?? 'application/pdf' });
}
