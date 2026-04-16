import { isNative } from './platform';

/**
 * Unified file storage facade.
 * Dispatches to @capacitor/filesystem on native, OPFS on web.
 * The backend module is resolved once and cached.
 */

/**
 * Shared contract for file storage backends. Both `./opfs` (web) and
 * `./nativeFs` (Capacitor) implement this surface; each module has a
 * `satisfies StorageBackend` assertion at the bottom so compile errors
 * catch drift rather than blowing up at runtime via the dynamic import
 * in `getBackend()` below.
 *
 * Backend-only exports NOT in this interface:
 *   - opfs: `getImageBlobWithSource`, `isOpfsWriteKnownBroken`,
 *           `isOpfsAvailable`, `requestPersistence`, `ImageBlobSource`
 *   - nativeFs: (none)
 * The `getImageBlobWithSource` helper below intentionally narrows to
 * opfs only — native has no Dexie fallback so source tracking is moot.
 *
 * `storeImage` returns `'opfs' | 'dexie'` on web (diagnostic signal for
 * which layer accepted the write) and `void` on native (no fallback).
 * The union below keeps both backends assignable while the public
 * `storeImage` re-export in this file normalizes to `ImageStoreBackend`.
 */
export interface StorageBackend {
  storeBookFile(pubId: number, file: File): Promise<void>;
  getBookFile(pubId: number): Promise<File | null>;
  deleteBookFiles(pubId: number): Promise<void>;
  storeImage(
    pubId: number,
    name: string,
    blob: Blob,
  ): Promise<'opfs' | 'dexie' | void>;
  getImageBlob(pubId: number, name: string): Promise<Blob | null>;
  storeCover(pubId: number, blob: Blob, ext: string): Promise<string>;
  getCoverBlob(path: string): Promise<Blob | null>;
}

let backend: Promise<StorageBackend> | null = null;

function getBackend(): Promise<StorageBackend> {
  if (!backend) {
    backend = isNative() ? import('./nativeFs') : import('./opfs');
  }
  return backend;
}

export async function storeBookFile(pubId: number, file: File): Promise<void> {
  const b = await getBackend();
  return b.storeBookFile(pubId, file);
}

export async function getBookFile(pubId: number): Promise<File | null> {
  const b = await getBackend();
  return b.getBookFile(pubId);
}

export async function deleteBookFiles(pubId: number): Promise<void> {
  const b = await getBackend();
  return b.deleteBookFiles(pubId);
}

export type ImageStoreBackend = 'opfs' | 'dexie' | 'native';

export async function storeImage(
  pubId: number,
  name: string,
  blob: Blob,
): Promise<ImageStoreBackend> {
  if (isNative()) {
    const b = await getBackend();
    await b.storeImage(pubId, name, blob);
    return 'native';
  }
  const b = await getBackend();
  // On web the backend is always ./opfs, whose storeImage resolves to
  // the narrower 'opfs' | 'dexie' union (never void). The shared
  // interface uses the wider union so nativeFs.storeImage (void) fits;
  // here we know we're on the opfs side and narrow back.
  const result = (await b.storeImage(pubId, name, blob)) as 'opfs' | 'dexie';
  return result;
}

export async function getImageBlob(
  pubId: number,
  name: string,
): Promise<Blob | null> {
  const b = await getBackend();
  return b.getImageBlob(pubId, name);
}

/**
 * Resolve a stored image reference to a browser-usable URL.
 * Logical image names are loaded from storage and turned into a fresh
 * object URL; already-browser-readable URLs are passed through.
 */
export async function getImageUrl(
  pubId: number,
  imageRef: string,
): Promise<string | null> {
  if (!imageRef) return null;
  if (
    imageRef.startsWith('blob:') ||
    imageRef.startsWith('data:') ||
    imageRef.startsWith('http://') ||
    imageRef.startsWith('https://') ||
    imageRef.startsWith('/')
  ) {
    return imageRef;
  }

  const blob = await getImageBlob(pubId, imageRef);
  if (!blob) return null;
  return URL.createObjectURL(blob);
}

export type ImageBlobSource = 'opfs' | 'dexie' | 'native' | 'missing';

/**
 * Source-aware variant for diagnostics. Returns which backend served the
 * blob — 'opfs' or 'dexie' on web, 'native' on Capacitor builds, 'missing'
 * if neither path resolved.
 */
export async function getImageBlobWithSource(
  pubId: number,
  name: string,
): Promise<{ blob: Blob | null; source: ImageBlobSource }> {
  if (isNative()) {
    const b = await getBackend();
    const blob = await b.getImageBlob(pubId, name);
    return { blob, source: blob ? 'native' : 'missing' };
  }
  const { getImageBlobWithSource } = await import('./opfs');
  return getImageBlobWithSource(pubId, name);
}

export async function storeCover(
  pubId: number,
  blob: Blob,
  ext: string,
): Promise<string> {
  const b = await getBackend();
  return b.storeCover(pubId, blob, ext);
}

export async function getCoverBlob(path: string): Promise<Blob | null> {
  const b = await getBackend();
  return b.getCoverBlob(path);
}

/** Returns an object URL for a stored cover, or null if not present. */
export async function getCoverUrl(path: string | null | undefined): Promise<string | null> {
  if (!path) return null;
  const blob = await getCoverBlob(path);
  if (!blob) return null;
  return URL.createObjectURL(blob);
}

export function isFileStorageAvailable(): boolean {
  if (isNative()) return true;
  return typeof navigator.storage?.getDirectory === 'function';
}
