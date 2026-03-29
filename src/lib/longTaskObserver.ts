let longTaskCount = 0;
let observer: PerformanceObserver | null = null;

export function startLongTaskObserver() {
  if (typeof PerformanceObserver === 'undefined') return;

  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskCount++;
        if (import.meta.env.DEV) {
          console.warn(`[Perf] Long task detected: ${entry.duration.toFixed(1)}ms`);
        }
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
  } catch {
    // Long Task API not supported
  }
}

export function getLongTaskCount(): number {
  return longTaskCount;
}

export function stopLongTaskObserver() {
  observer?.disconnect();
  observer = null;
}
