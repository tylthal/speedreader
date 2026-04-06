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

export async function storeImage(
  pubId: number,
  name: string,
  blob: Blob,
): Promise<void> {
  if (isNative()) {
    const { storeImage } = await import('./nativeFs');
    return storeImage(pubId, name, blob);
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

export function isFileStorageAvailable(): boolean {
  if (isNative()) return true;
  return typeof navigator.storage?.getDirectory === 'function';
}
