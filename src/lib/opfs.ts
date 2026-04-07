/**
 * OPFS (Origin Private File System) utilities for storing raw ebook files
 * and extracted images.
 *
 * Directory structure:
 *   /books/{pubId}/original.{ext}   — raw uploaded file
 *   /images/{pubId}/{name}          — extracted images
 *
 * --- Mobile WebKit fallback ---
 *
 * iOS Safari (and older mobile WebKit) does not support
 * FileSystemFileHandle.createWritable() — calling it throws on every
 * storeImage / storeCover. Without a fallback, every upload on mobile
 * silently lands a publication in the library with zero images on disk
 * and a formatted view that can't ever resolve its `opfs:NAME` markers.
 *
 * This module catches createWritable failures, sets a session-wide flag
 * (`opfsWritesKnownBroken`), and falls back to writing the blob into the
 * Dexie `blob_storage` table. Reads check OPFS first and then Dexie, so
 * an existing OPFS-stored asset (from a previous browser that supported
 * createWritable) still resolves correctly. Once the session flag flips,
 * subsequent writes skip OPFS entirely to avoid retrying a known failure.
 */

import { db } from '../db/database'

let _root: FileSystemDirectoryHandle | null = null

/**
 * Set to true the first time an OPFS write throws. Per-session — we don't
 * persist it because a browser update could fix support, and the cost of
 * one extra failed write per session is trivial.
 */
let opfsWritesKnownBroken = false

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

/**
 * Try to write `blob` via OPFS. Returns true on success, false on
 * createWritable failure (in which case the caller should fall back to
 * Dexie). Other errors (quota, permission) propagate.
 */
async function tryOpfsWrite(
  dir: FileSystemDirectoryHandle,
  fileName: string,
  blob: Blob,
): Promise<boolean> {
  if (opfsWritesKnownBroken) return false
  try {
    const handle = await dir.getFileHandle(fileName, { create: true })
    // createWritable is the operation that throws on iOS Safari. We catch
    // narrowly so quota/permission errors still bubble up to the caller.
    let writable: FileSystemWritableFileStream
    try {
      writable = await handle.createWritable()
    } catch (err) {
      console.warn('[opfs] createWritable unsupported — falling back to Dexie', err)
      opfsWritesKnownBroken = true
      return false
    }
    await writable.write(blob)
    await writable.close()
    return true
  } catch (err) {
    // Anything other than createWritable failing means OPFS itself is
    // having a real problem. Mark as broken so we don't retry, but log
    // the actual reason.
    console.warn('[opfs] write failed — falling back to Dexie', err)
    opfsWritesKnownBroken = true
    return false
  }
}

async function dexiePutBlob(
  key: string,
  blob: Blob,
  extra?: { mime?: string; filename?: string | null },
): Promise<void> {
  await db.blob_storage.put({
    key,
    blob,
    mime: extra?.mime ?? blob.type,
    filename: extra?.filename ?? null,
  })
}

async function dexieGetBlob(key: string): Promise<Blob | null> {
  const row = await db.blob_storage.get(key)
  return row?.blob ?? null
}

async function dexieDeleteByPrefix(prefix: string): Promise<void> {
  // Dexie doesn't support startsWith on string primary keys directly via
  // .where('key').startsWith(...) on a non-indexed primary key — but
  // primary keys ARE indexable. We use the where() form which works for
  // primary keys in Dexie 4.
  await db.blob_storage.where('key').startsWith(prefix).delete()
}

/** Exposed for diagnostics — currently unused outside this module. */
export function isOpfsWriteKnownBroken(): boolean {
  return opfsWritesKnownBroken
}

// ---------------------------------------------------------------------------
// Raw ebook file storage
// ---------------------------------------------------------------------------

function bookDexieKey(pubId: number): string {
  return `book:${pubId}`
}

export async function storeBookFile(pubId: number, file: File): Promise<void> {
  const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : ''
  if (!opfsWritesKnownBroken) {
    try {
      const dir = await getDir('books', String(pubId))
      const fileOk = await tryOpfsWrite(dir, `original${ext}`, file)
      if (fileOk) {
        // Metadata write — same fallback rules. If just THIS write fails
        // we still want the original file we already wrote, so persist
        // the metadata to Dexie under a sidecar key.
        const metaBlob = new Blob(
          [
            JSON.stringify({
              filename: file.name,
              mime: file.type,
              size: file.size,
              storedAt: new Date().toISOString(),
            }),
          ],
          { type: 'application/json' },
        )
        const metaOk = await tryOpfsWrite(dir, 'meta.json', metaBlob)
        if (!metaOk) {
          await dexiePutBlob(`book-meta:${pubId}`, metaBlob, {
            mime: 'application/json',
            filename: file.name,
          })
        }
        return
      }
    } catch (err) {
      console.warn('[opfs] book dir failed — falling back to Dexie', err)
      opfsWritesKnownBroken = true
    }
  }
  // Full Dexie fallback — store the file blob with the original filename
  // recorded so getBookFile can rebuild a File object with it.
  await dexiePutBlob(bookDexieKey(pubId), file, {
    mime: file.type,
    filename: file.name,
  })
}

export async function getBookFile(pubId: number): Promise<File | null> {
  // OPFS first.
  try {
    const dir = await getDir('books', String(pubId))
    let meta: { filename?: string; mime?: string } | null = null
    try {
      const metaHandle = await dir.getFileHandle('meta.json')
      const metaFile = await metaHandle.getFile()
      meta = JSON.parse(await metaFile.text())
    } catch {
      // Try the Dexie sidecar (storeBookFile may have written file to OPFS
      // and meta to Dexie if createWritable broke between the two writes).
      const sidecar = await dexieGetBlob(`book-meta:${pubId}`)
      if (sidecar) {
        try {
          meta = JSON.parse(await sidecar.text())
        } catch {
          meta = null
        }
      }
    }

    for await (const [name, entry] of (dir as any).entries()) {
      if (name.startsWith('original') && entry.kind === 'file') {
        const file = await (entry as FileSystemFileHandle).getFile()
        return new File([file], meta?.filename ?? name, {
          type: meta?.mime ?? file.type,
        })
      }
    }
  } catch {
    /* fall through to Dexie */
  }

  // Dexie fallback — the entire book file lives in blob_storage.
  const row = await db.blob_storage.get(bookDexieKey(pubId))
  if (!row) return null
  return new File([row.blob], row.filename ?? `book-${pubId}`, {
    type: row.mime ?? row.blob.type,
  })
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

  // Mirror the cleanup in the Dexie fallback table — important when the
  // user's session was using Dexie because OPFS writes were broken, but
  // also harmless when they weren't (deleteByPrefix is a no-op on missing
  // keys).
  try {
    await dexieDeleteByPrefix(`image:${pubId}:`)
    await dexieDeleteByPrefix(`cover:${pubId}.`)
    await db.blob_storage.delete(bookDexieKey(pubId))
    await db.blob_storage.delete(`book-meta:${pubId}`)
  } catch (err) {
    console.warn('[opfs] dexie cleanup failed for pub', pubId, err)
  }
}

// ---------------------------------------------------------------------------
// Cover image storage (PRD §3.4)
// ---------------------------------------------------------------------------

function coverDexieKey(pubId: number, ext: string): string {
  return `cover:${pubId}${ext}`
}

export async function storeCover(
  pubId: number,
  blob: Blob,
  ext: string,
): Promise<string> {
  const name = `${pubId}${ext}`
  // We always return the same `covers/{name}` path regardless of which
  // backend stored it. getCoverBlob below tries OPFS first then Dexie, so
  // the publication's cover_path stays storage-agnostic and existing rows
  // from earlier OPFS-only sessions still resolve.
  if (!opfsWritesKnownBroken) {
    try {
      const dir = await getDir('covers')
      if (await tryOpfsWrite(dir, name, blob)) return `covers/${name}`
    } catch (err) {
      console.warn('[opfs] cover dir failed — falling back to Dexie', err)
      opfsWritesKnownBroken = true
    }
  }
  await dexiePutBlob(coverDexieKey(pubId, ext), blob, { mime: blob.type })
  return `covers/${name}`
}

export async function getCoverBlob(path: string): Promise<Blob | null> {
  try {
    const parts = path.split('/').filter(Boolean)
    if (parts.length < 2 || parts[0] !== 'covers') return null
    // OPFS first.
    try {
      const dir = await getDir('covers')
      const handle = await dir.getFileHandle(parts[1])
      return await handle.getFile()
    } catch {
      /* fall through to Dexie */
    }
    // Dexie key is `cover:{filename}` where filename is `{pubId}.{ext}`.
    const dexieKey = `cover:${parts[1]}`
    return await dexieGetBlob(dexieKey)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Image storage
// ---------------------------------------------------------------------------

function imageDexieKey(pubId: number, name: string): string {
  return `image:${pubId}:${name}`
}

export async function storeImage(
  pubId: number,
  name: string,
  blob: Blob,
): Promise<void> {
  if (!opfsWritesKnownBroken) {
    try {
      const dir = await getDir('images', String(pubId))
      if (await tryOpfsWrite(dir, name, blob)) return
    } catch (err) {
      console.warn('[opfs] image dir failed — falling back to Dexie', err)
      opfsWritesKnownBroken = true
    }
  }
  await dexiePutBlob(imageDexieKey(pubId, name), blob)
}

export async function getImageBlob(
  pubId: number,
  name: string,
): Promise<Blob | null> {
  // OPFS first — covers any image stored before the session noticed writes
  // were broken, plus the entire desktop happy path.
  try {
    const dir = await getDir('images', String(pubId))
    const handle = await dir.getFileHandle(name)
    return await handle.getFile()
  } catch {
    /* fall through to Dexie */
  }
  return dexieGetBlob(imageDexieKey(pubId, name))
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
