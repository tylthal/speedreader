import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

/**
 * Native filesystem storage — mirrors the OPFS API surface but uses
 * @capacitor/filesystem for unlimited file sizes on iOS/Android.
 *
 * Directory structure:
 *   books/{pubId}/original.{ext}
 *   books/{pubId}/meta.json
 *   images/{pubId}/{name}
 */

export async function storeBookFile(pubId: number, file: File): Promise<void> {
  const ext = file.name.includes('.')
    ? file.name.slice(file.name.lastIndexOf('.'))
    : '';

  const base64 = await fileToBase64(file);

  await Filesystem.writeFile({
    path: `books/${pubId}/original${ext}`,
    data: base64,
    directory: Directory.Data,
    recursive: true,
  });

  await Filesystem.writeFile({
    path: `books/${pubId}/meta.json`,
    data: JSON.stringify({
      filename: file.name,
      mime: file.type,
      size: file.size,
      storedAt: new Date().toISOString(),
    }),
    directory: Directory.Data,
    encoding: Encoding.UTF8,
    recursive: true,
  });
}

export async function getBookFile(pubId: number): Promise<File | null> {
  try {
    const metaResult = await Filesystem.readFile({
      path: `books/${pubId}/meta.json`,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    const meta = JSON.parse(metaResult.data as string);

    const files = await Filesystem.readdir({
      path: `books/${pubId}`,
      directory: Directory.Data,
    });
    const original = files.files.find((f) => f.name.startsWith('original'));
    if (!original) return null;

    const result = await Filesystem.readFile({
      path: `books/${pubId}/${original.name}`,
      directory: Directory.Data,
    });
    const blob = base64ToBlob(result.data as string, meta.mime);
    return new File([blob], meta.filename, { type: meta.mime });
  } catch {
    return null;
  }
}

export async function deleteBookFiles(pubId: number): Promise<void> {
  try {
    await Filesystem.rmdir({
      path: `books/${pubId}`,
      directory: Directory.Data,
      recursive: true,
    });
  } catch {
    /* directory may not exist */
  }
  try {
    await Filesystem.rmdir({
      path: `images/${pubId}`,
      directory: Directory.Data,
      recursive: true,
    });
  } catch {
    /* directory may not exist */
  }
}

export async function storeImage(
  pubId: number,
  name: string,
  blob: Blob,
): Promise<void> {
  const base64 = await blobToBase64(blob);
  await Filesystem.writeFile({
    path: `images/${pubId}/${name}`,
    data: base64,
    directory: Directory.Data,
    recursive: true,
  });
}

export async function getImageBlob(
  pubId: number,
  name: string,
): Promise<Blob | null> {
  try {
    const result = await Filesystem.readFile({
      path: `images/${pubId}/${name}`,
      directory: Directory.Data,
    });
    return base64ToBlob(result.data as string, 'image/png');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64: string, mime: string): Blob {
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
