/**
 * OPFS (Origin Private File System) utilities for storing
 * raw ebook files and extracted images.
 *
 * Directory structure:
 *   /books/{pubId}/original.{ext}   — raw uploaded file
 *   /images/{pubId}/{name}          — extracted images
 */

let _root: FileSystemDirectoryHandle | null = null

async function getRoot(): Promise<FileSystemDirectoryHandle> {
  if (!_root) {
    _root = await navigator.storage.getDirectory()
  }
  return _root
}

async function getDir(
  ...pathParts: string[]
): Promise<FileSystemDirectoryHandle> {
  let dir = await getRoot()
  for (const part of pathParts) {
    dir = await dir.getDirectoryHandle(part, { create: true })
  }
  return dir
}

// ---------------------------------------------------------------------------
// Raw ebook file storage
// ---------------------------------------------------------------------------

export async function storeBookFile(pubId: number, file: File): Promise<void> {
  const dir = await getDir('books', String(pubId))
  const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : ''
  const handle = await dir.getFileHandle(`original${ext}`, { create: true })
  const writable = await handle.createWritable()
  await writable.write(file)
  await writable.close()

  // Store metadata
  const metaHandle = await dir.getFileHandle('meta.json', { create: true })
  const metaWritable = await metaHandle.createWritable()
  await metaWritable.write(JSON.stringify({
    filename: file.name,
    mime: file.type,
    size: file.size,
    storedAt: new Date().toISOString(),
  }))
  await metaWritable.close()
}

export async function getBookFile(pubId: number): Promise<File | null> {
  try {
    const dir = await getDir('books', String(pubId))
    const metaHandle = await dir.getFileHandle('meta.json')
    const metaFile = await metaHandle.getFile()
    const meta = JSON.parse(await metaFile.text())

    // Find the original file
    for await (const [name, entry] of (dir as any).entries()) {
      if (name.startsWith('original') && entry.kind === 'file') {
        const file = await (entry as FileSystemFileHandle).getFile()
        return new File([file], meta.filename, { type: meta.mime })
      }
    }
  } catch {
    // Not found
  }
  return null
}

export async function deleteBookFiles(pubId: number): Promise<void> {
  try {
    const booksDir = await getDir('books')
    await booksDir.removeEntry(String(pubId), { recursive: true })
  } catch {
    // Already deleted or doesn't exist
  }
  try {
    const imagesDir = await getDir('images')
    await imagesDir.removeEntry(String(pubId), { recursive: true })
  } catch {
    // Already deleted or doesn't exist
  }
  try {
    const coversDir = await getDir('covers')
    // covers are flat files named {pubId}.{ext}
    for await (const [name] of (coversDir as any).entries()) {
      if (name.startsWith(`${pubId}.`)) {
        await coversDir.removeEntry(name).catch(() => {})
      }
    }
  } catch {
    // Already deleted or doesn't exist
  }
}

// ---------------------------------------------------------------------------
// Cover image storage (PRD §3.4)
// ---------------------------------------------------------------------------

export async function storeCover(
  pubId: number,
  blob: Blob,
  ext: string,
): Promise<string> {
  const dir = await getDir('covers')
  const name = `${pubId}${ext}`
  const handle = await dir.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  await writable.write(blob)
  await writable.close()
  return `covers/${name}`
}

export async function getCoverBlob(path: string): Promise<Blob | null> {
  try {
    const parts = path.split('/').filter(Boolean)
    if (parts.length < 2 || parts[0] !== 'covers') return null
    const dir = await getDir('covers')
    const handle = await dir.getFileHandle(parts[1])
    return await handle.getFile()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Image storage
// ---------------------------------------------------------------------------

export async function storeImage(
  pubId: number,
  name: string,
  blob: Blob,
): Promise<void> {
  const dir = await getDir('images', String(pubId))
  const handle = await dir.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  await writable.write(blob)
  await writable.close()
}

export async function getImageBlob(
  pubId: number,
  name: string,
): Promise<Blob | null> {
  try {
    const dir = await getDir('images', String(pubId))
    const handle = await dir.getFileHandle(name)
    return await handle.getFile()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Storage persistence
// ---------------------------------------------------------------------------

export async function requestPersistence(): Promise<boolean> {
  if (navigator.storage?.persist) {
    return navigator.storage.persist()
  }
  return false
}

// ---------------------------------------------------------------------------
// OPFS availability check
// ---------------------------------------------------------------------------

export function isOpfsAvailable(): boolean {
  return typeof navigator.storage?.getDirectory === 'function'
}
