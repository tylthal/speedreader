import { useState, useEffect, useCallback } from 'react';
import { onMetric, getMetrics } from '../lib/performance';
import { getTTFC } from '../lib/ttfcMetric';
import { getLongTaskCount } from '../lib/longTaskObserver';

interface MetricEntry {
  name: string;
  value: number;
  rating: 'good' | 'needs-improvement' | 'poor';
}

const ratingColor = (rating: MetricEntry['rating']): string => {
  switch (rating) {
    case 'good': return '#22c55e';
    case 'needs-improvement': return '#f59e0b';
    case 'poor': return '#ef4444';
  }
};

export default function PerfOverlay() {
  const [visible, setVisible] = useState(false);
  const [vitals, setVitals] = useState<Map<string, MetricEntry>>(new Map());
  const [ttfc, setTtfc] = useState<number | null>(null);
  const [longTasks, setLongTasks] = useState(0);

  // Subscribe to web vitals
  useEffect(() => {
    if (!import.meta.env.DEV) return;

    // Load any metrics already collected
    const existing = getMetrics();
    if (existing.length > 0) {
      setVitals(prev => {
        const next = new Map(prev);
        for (const m of existing) {
          next.set(m.name, { name: m.name, value: m.value, rating: m.rating });
        }
        return next;
      });
    }

    const unsub = onMetric((m) => {
      setVitals(prev => {
        const next = new Map(prev);
        next.set(m.name, { name: m.name, value: m.value, rating: m.rating });
        return next;
      });
    });

    return unsub;
  }, []);

  // Poll TTFC and long tasks periodically when visible
  useEffect(() => {
    if (!import.meta.env.DEV || !visible) return;

    const interval = setInterval(() => {
      setTtfc(getTTFC());
      setLongTasks(getLongTaskCount());
    }, 1000);

    // Immediate update
    setTtfc(getTTFC());
    setLongTasks(getLongTaskCount());

    return () => clearInterval(interval);
  }, [visible]);

  // Keyboard shortcut: Ctrl+Shift+P
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'P') {
      e.preventDefault();
      setVisible(v => !v);
    }
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!import.meta.env.DEV || !visible) return null;

  const vitalNames = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'];

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '8px',
        right: '8px',
        zIndex: 99999,
        background: 'rgba(0, 0, 0, 0.82)',
        color: '#e0e0e0',
        fontFamily: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace',
        fontSize: '11px',
        lineHeight: '1.5',
        padding: '8px 10px',
        borderRadius: '6px',
        pointerEvents: 'auto',
        minWidth: '150px',
        backdropFilter: 'blur(8px)',
        border: '1px solid rgba(255,255,255,0.1)',
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: '4px', color: '#aaa', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        Perf
      </div>
      {vitalNames.map(name => {
        const entry = vitals.get(name);
        return (
          <div key={name} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
            <span>{name}</span>
            {entry ? (
              <span style={{ color: ratingColor(entry.rating) }}>
                {entry.value.toFixed(1)}{name === 'CLS' ? '' : 'ms'}
              </span>
            ) : (
              <span style={{ color: '#555' }}>--</span>
            )}
          </div>
        );
      })}
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', marginTop: '4px', paddingTop: '4px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
          <span>TTFC</span>
          <span style={{ color: ttfc !== null ? '#60a5fa' : '#555' }}>
            {ttfc !== null ? `${ttfc.toFixed(1)}ms` : '--'}
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
          <span>Long Tasks</span>
          <span style={{ color: longTasks > 0 ? '#f59e0b' : '#22c55e' }}>
            {longTasks}
          </span>
        </div>
      </div>
    </div>
  );
}
