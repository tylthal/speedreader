let ttfcMark: number | null = null;
let ttfcValue: number | null = null;

export function markNavigationStart() {
  ttfcMark = performance.now();
}

export function markFirstChunkRendered() {
  if (ttfcMark !== null && ttfcValue === null) {
    ttfcValue = performance.now() - ttfcMark;
    if (import.meta.env.DEV) {
      console.log(`%c[Perf] Time to First Chunk: ${ttfcValue.toFixed(1)}ms`, 'color: blue');
    }
  }
}

export function getTTFC(): number | null {
  return ttfcValue;
}

export function resetTTFC() {
  ttfcMark = null;
  ttfcValue = null;
}
