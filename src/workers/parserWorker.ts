/**
 * Web Worker that runs file parsing + section chunking off the main thread.
 *
 * Note: this worker is currently not invoked — runParse() in localClient.ts
 * always uses the main-thread fallback because Safari/WebKit doesn't expose
 * DOMParser in workers. The protocol is kept in lock-step with the
 * main-thread implementation so we can re-enable workers if Safari ships the
 * fix.
 */

import { parseFile } from '../parsers'
import type { ParsedBook } from '../parsers/types'
import type {
  ParseRequest,
  WorkerOutMessage,
} from './parserProtocol'
import { buildWorkerResult } from './buildWorkerResult'

function post(msg: WorkerOutMessage, transfer?: Transferable[]) {
  self.postMessage(msg, { transfer: transfer ?? [] })
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

self.onmessage = (e: MessageEvent<ParseRequest>) => {
  if (e.data.type === 'parse') {
    handleParse(e.data)
  }
}
