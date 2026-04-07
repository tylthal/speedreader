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
// handler on the worker's global scope.
import 'pdfjs-dist/legacy/build/pdf.worker.mjs'
