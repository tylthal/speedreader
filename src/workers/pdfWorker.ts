/**
 * Wrapper around pdfjs-dist's worker that polyfills ReadableStream's async
 * iterator before loading pdf.js. WebKit (Safari, iOS Chrome) does not expose
 * Symbol.asyncIterator on ReadableStream until very recent versions, and
 * pdfjs-dist's worker uses `for await (... of stream)` internally.
 */

if (
  typeof ReadableStream !== 'undefined' &&
  !(ReadableStream.prototype as any)[Symbol.asyncIterator]
) {
  (ReadableStream.prototype as any)[Symbol.asyncIterator] = async function* () {
    const reader = this.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        yield value
      }
    } finally {
      reader.releaseLock()
    }
  }
}

// Importing the worker module runs its setup, which registers the message
// handler on the worker's global scope. This static import is intentional:
// (1) pdf.js registers `self.onmessage` synchronously at import time; a
// top-level dynamic import would race with the first postMessage from the
// main thread (and the configured browser target doesn't allow top-level
// await anyway). (2) The whole *worker file* is built as a separate chunk
// by Vite's `?worker` suffix, and is only fetched when `new PdfWorker()`
// is invoked. Since `new PdfWorker()` is now deferred into the lazy
// `loadPdfJs()` path in src/parsers/pdfParser.ts, the heavy worker payload
// is not loaded until a real PDF parse is started.
import 'pdfjs-dist/legacy/build/pdf.worker.mjs'
