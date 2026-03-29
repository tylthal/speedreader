import { onLCP, onINP, onCLS, onFCP, onTTFB } from 'web-vitals';

interface PerfMetric {
  name: string;
  value: number;
  rating: 'good' | 'needs-improvement' | 'poor';
  timestamp: number;
}

// Collect metrics in memory for the dev overlay
const metrics: PerfMetric[] = [];
const listeners: Set<(m: PerfMetric) => void> = new Set();

function reportMetric(metric: { name: string; value: number; rating: string }) {
  const entry: PerfMetric = {
    name: metric.name,
    value: metric.value,
    rating: metric.rating as PerfMetric['rating'],
    timestamp: Date.now(),
  };
  metrics.push(entry);
  listeners.forEach(fn => fn(entry));

  // Log to console in development
  if (import.meta.env.DEV) {
    const color = entry.rating === 'good' ? 'green' : entry.rating === 'needs-improvement' ? 'orange' : 'red';
    console.log(`%c[Perf] ${entry.name}: ${entry.value.toFixed(1)}ms (${entry.rating})`, `color: ${color}`);
  }
}

export function initWebVitals() {
  onLCP(reportMetric);
  onINP(reportMetric);
  onCLS(reportMetric);
  onFCP(reportMetric);
  onTTFB(reportMetric);
}

export function getMetrics(): PerfMetric[] {
  return [...metrics];
}

export function onMetric(fn: (m: PerfMetric) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
