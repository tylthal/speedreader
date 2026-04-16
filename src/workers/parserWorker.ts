/**
 * Web Worker that runs file parsing + section chunking off the main thread.
 *
 * Safari/WebKit historically didn't expose DOMParser inside workers, so the
 * main thread feature-detects by sending a `ping` message before committing
 * to the worker path (see src/lib/parserWorkerClient.ts). On browsers where
 * the detection succeeds, uploads for EPUB/FB2/DOCX/etc. de-jank the main
 * thread by 1-2 s on large books. When detection fails (or the worker
 * errors), localClient silently falls back to main-thread parseFile().
 *
 * PDFs are intentionally routed through main-thread parsing by the client
 * because pdfParser.renderPageToBlob() uses `document.createElement('canvas')`
 * for cover rendering, which is unavailable in a worker.
 */

import { parseFile } from '../parsers'
import type { ParsedBook } from '../parsers/types'
import type {
  ParseRequest,
  PingRequest,
  WorkerInMessage,
  WorkerOutMessage,
} from './parserProtocol'
import { buildWorkerResult } from './buildWorkerResult'

function post(msg: WorkerOutMessage, transfer?: Transferable[]) {
  self.postMessage(msg, { transfer: transfer ?? [] })
}

function handlePing(req: PingRequest) {
  post({
    type: 'pong',
    id: req.id,
    hasDOMParser: typeof DOMParser !== 'undefined',
  })
}

async function handleParse(req: ParseRequest) {
  const { id, data, filename } = req
  try {
    post({ type: 'progress', id, phase: 'parsing', percent: 0 })
    const book: ParsedBook = await parseFile(data, filename)
    post({ type: 'progress', id, phase: 'parsing', percent: 100 })

    post({ type: 'progress', id, phase: 'chunking', percent: 0 })
    const { result, transferables } = await buildWorkerResult(book)
    post({ type: 'progress', id, phase: 'chunking', percent: 100 })

    post({ type: 'done', id, result }, transferables)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Parsing failed'
    post({ type: 'error', id, message })
  }
}

self.onmessage = (e: MessageEvent<WorkerInMessage>) => {
  const msg = e.data
  if (msg.type === 'ping') {
    handlePing(msg)
  } else if (msg.type === 'parse') {
    handleParse(msg)
  }
}
