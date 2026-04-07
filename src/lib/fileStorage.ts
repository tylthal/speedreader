import { isNative } from './platform';

/**
 * Unified file storage facade.
 * Dispatches to @capacitor/filesystem on native, OPFS on web.
 * Uses dynamic imports so native code is never loaded in the browser.
 */

export async function storeBookFile(
  pubId: number,
  file: File,
): Promise<void> {
  if (isNative()) {
    const { storeBookFile } = await import('./nativeFs');
    return storeBookFile(pubId, file);
  }
  const { storeBookFile } = await import('./opfs');
  return storeBookFile(pubId, file);
}

export async function getBookFile(pubId: number): Promise<File | null> {
  if (isNative()) {
    const { getBookFile } = await import('./nativeFs');
    return getBookFile(pubId);
  }
  const { getBookFile } = await import('./opfs');
  return getBookFile(pubId);
}

export async function deleteBookFiles(pubId: number): Promise<void> {
  if (isNative()) {
    const { deleteBookFiles } = await import('./nativeFs');
    return deleteBookFiles(pubId);
  }
  const { deleteBookFiles } = await import('./opfs');
  return deleteBookFiles(pubId);
}

export type ImageStoreBackend = 'opfs' | 'dexie' | 'native';

export async function storeImage(
  pubId: number,
  name: string,
  blob: Blob,
): Promise<ImageStoreBackend> {
  if (isNative()) {
    const { storeImage } = await import('./nativeFs');
    await storeImage(pubId, name, blob);
    return 'native';
  }
  const { storeImage } = await import('./opfs');
  return storeImage(pubId, name, blob);
}

export async function getImageBlob(
  pubId: number,
  name: string,
): Promise<Blob | null> {
  if (isNative()) {
    const { getImageBlob } = await import('./nativeFs');
    return getImageBlob(pubId, name);
  }
  const { getImageBlob } = await import('./opfs');
  return getImageBlob(pubId, name);
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
    const { getImageBlob } = await import('./nativeFs');
    const blob = await getImageBlob(pubId, name);
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
  if (isNative()) {
    const { storeCover } = await import('./nativeFs');
    return storeCover(pubId, blob, ext);
  }
  const { storeCover } = await import('./opfs');
  return storeCover(pubId, blob, ext);
}

export async function getCoverBlob(path: string): Promise<Blob | null> {
  if (isNative()) {
    const { getCoverBlob } = await import('./nativeFs');
    return getCoverBlob(path);
  }
  const { getCoverBlob } = await import('./opfs');
  return getCoverBlob(path);
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
