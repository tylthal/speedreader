/**
 * Feature-detecting client for the parser Web Worker.
 *
 * Strategy:
 *   1. First call: spawn the worker, send a `ping`, wait for `pong` with
 *      `hasDOMParser: true`. Cache the result module-scope so subsequent
 *      uploads reuse the same worker (no respawn, no redetect).
 *   2. Safari/WebKit: `DOMParser` is not exposed in workers, so the pong
 *      reports `hasDOMParser: false`; we tear down the worker and fall
 *      through to main-thread parsing forever.
 *   3. Any failure during detection (worker module fails to load, ping
 *      times out, worker throws) is silently treated as "unsupported" —
 *      main-thread parsing is always a safe fallback.
 *   4. PDFs are always routed to the main thread by the caller because
 *      pdfParser.renderPageToBlob() uses `document.createElement('canvas')`
 *      which is unavailable in workers.
 */

import type {
  ParseRequest,
  WorkerOutMessage,
  WorkerResult,
} from '../workers/parserProtocol'

type ProgressCallback = (phase: string, percent: number) => void

const PING_TIMEOUT_MS = 3000

let detectPromise: Promise<Worker | null> | null = null
let sharedWorker: Worker | null = null

async function createWorker(): Promise<Worker> {
  // Dynamic import so the worker chunk isn't fetched until we actually
  // need it (first upload), matching how pdfWorker is wired up.
  const mod = await import('../workers/parserWorker.ts?worker')
  const WorkerCtor = mod.default
  return new WorkerCtor()
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * Spawn a worker and confirm it has DOMParser. Returns the usable Worker on
 * success, or null on any failure (at which point the caller falls back).
 */
async function detectAndCacheWorker(): Promise<Worker | null> {
  let worker: Worker
  try {
    worker = await createWorker()
  } catch (err) {
    console.warn('[parserWorker] failed to spawn worker; using main thread', err)
    return null
  }

  const pingId = makeId()

  const pongPromise = new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      clearTimeout(timer)
      resolve(ok)
    }
    const onMessage = (e: MessageEvent<WorkerOutMessage>) => {
      const msg = e.data
      if (msg.type === 'pong' && msg.id === pingId) {
        finish(msg.hasDOMParser === true)
      }
    }
    const onError = () => finish(false)
    const timer = setTimeout(() => finish(false), PING_TIMEOUT_MS)
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
  })

  try {
    worker.postMessage({ type: 'ping', id: pingId })
  } catch (err) {
    console.warn('[parserWorker] postMessage(ping) failed', err)
    worker.terminate()
    return null
  }

  const hasDOMParser = await pongPromise
  if (!hasDOMParser) {
    console.info('[parserWorker] DOMParser unavailable in worker; using main thread')
    worker.terminate()
    return null
  }

  return worker
}

/**
 * Returns a ready worker if the environment supports one, or null.
 * Safe to call repeatedly — detection runs at most once per session.
 */
async function getWorker(): Promise<Worker | null> {
  if (sharedWorker) return sharedWorker
  if (!detectPromise) {
    detectPromise = detectAndCacheWorker().then((w) => {
      sharedWorker = w
      return w
    })
  }
  return detectPromise
}

/**
 * True iff the worker path is usable for the given filename. PDFs always
 * go to the main thread because cover rendering needs `document`.
 */
export function canUseParserWorker(filename: string): boolean {
  return !/\.pdf$/i.test(filename)
}

/**
 * Run a parse on the worker. Returns null if the worker is unavailable or
 * fails; callers should fall back to main-thread parsing on null.
 *
 * The caller retains ownership of `data`. We copy the ArrayBuffer before
 * transferring so the caller's reference stays intact (handy if it also
 * needs to persist the raw file via storeBookFile()).
 */
export async function parseWithWorker(
  data: ArrayBuffer,
  filename: string,
  onProgress?: ProgressCallback,
): Promise<WorkerResult | null> {
  if (!canUseParserWorker(filename)) return null

  const worker = await getWorker()
  if (!worker) return null

  const id = makeId()
  const transferBuffer = data.slice(0)

  return new Promise<WorkerResult | null>((resolve) => {
    let settled = false
    const finish = (result: WorkerResult | null) => {
      if (settled) return
      settled = true
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      resolve(result)
    }
    const onMessage = (e: MessageEvent<WorkerOutMessage>) => {
      const msg = e.data
      if (msg.id !== id) return
      switch (msg.type) {
        case 'progress':
          onProgress?.(msg.phase, msg.percent)
          return
        case 'done':
          finish(msg.result)
          return
        case 'error':
          console.warn('[parserWorker] parse error, falling back', msg.message)
          finish(null)
          return
      }
    }
    const onError = (ev: ErrorEvent) => {
      console.warn('[parserWorker] worker error, falling back', ev.message)
      finish(null)
    }
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)

    const req: ParseRequest = { type: 'parse', id, data: transferBuffer, filename }
    try {
      worker.postMessage(req, [transferBuffer])
    } catch (err) {
      console.warn('[parserWorker] postMessage(parse) failed', err)
      finish(null)
    }
  })
}

/** Test-only reset so unit tests can re-run detection. */
export function __resetParserWorkerClientForTests(): void {
  if (sharedWorker) {
    try { sharedWorker.terminate() } catch { /* ignore */ }
  }
  sharedWorker = null
  detectPromise = null
}
