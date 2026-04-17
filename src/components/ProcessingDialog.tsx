import { useEffect, useRef, useState } from 'react';

interface ProcessingDialogProps {
  filename: string;
  phase: string; // 'parsing' | 'chunking' | ''
  percent: number;
  onCancel?: () => void;
}

const PHASE_LABELS: Record<string, { title: string; subtitle: string; step: number }> = {
  '': { title: 'Opening your book', subtitle: 'Everything stays on this device.', step: 1 },
  parsing: { title: 'Reading your book', subtitle: 'Finding chapters, text, and images.', step: 1 },
  chunking: { title: 'Getting it ready', subtitle: 'Building the reading view and progress map.', step: 2 },
};

const STALL_MS = 8_000;

export default function ProcessingDialog({ filename, phase, percent, onCancel }: ProcessingDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [displayPercent, setDisplayPercent] = useState(0);
  const [stalled, setStalled] = useState(false);
  const lastProgressAtRef = useRef<number>(0);
  const lastPercentRef = useRef(percent);

  useEffect(() => {
    lastProgressAtRef.current = Date.now();
  }, []);

  // Smooth percentage animation
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      setDisplayPercent(percent);
    });
    return () => cancelAnimationFrame(id);
  }, [percent]);

  // Track stalls — if percent doesn't change for 8s, flip the subtitle
  // to a reassuring "large file" message.
  useEffect(() => {
    if (percent !== lastPercentRef.current) {
      lastPercentRef.current = percent;
      lastProgressAtRef.current = Date.now();
      if (stalled) setStalled(false);
    }
    const id = setInterval(() => {
      if (Date.now() - lastProgressAtRef.current > STALL_MS) {
        setStalled(true);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [percent, stalled]);

  // Animate in
  useEffect(() => {
    requestAnimationFrame(() => {
      dialogRef.current?.classList.add('processing-dialog--visible');
    });
  }, []);

  const labels = PHASE_LABELS[phase] || PHASE_LABELS[''];
  const format = filename.split('.').pop()?.toUpperCase() || 'FILE';
  const stalledSubtitle = 'Large file — still working…';

  // Progress ring dimensions
  const size = 120;
  const strokeWidth = 4;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (displayPercent / 100) * circumference;

  return (
    <div className="processing-dialog__overlay">
      <div ref={dialogRef} className="processing-dialog" role="alertdialog" aria-label="Processing book">
        <span className="processing-dialog__stepper">Step {labels.step} of 2</span>

        {/* Animated progress ring */}
        <div className="processing-dialog__ring-container">
          <svg
            className="processing-dialog__ring"
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
          >
            {/* Track */}
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke="var(--progress-track)"
              strokeWidth={strokeWidth}
            />
            {/* Progress arc */}
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              className="processing-dialog__ring-progress"
            />
          </svg>

          {/* Center content: book icon + percentage */}
          <div className="processing-dialog__ring-center">
            <svg className="processing-dialog__book-icon" width="32" height="32" viewBox="0 0 32 32" fill="none">
              <path
                d="M6 4C6 2.9 6.9 2 8 2H20L26 8V28C26 29.1 25.1 30 24 30H8C6.9 30 6 29.1 6 28V4Z"
                fill="var(--accent-subtle)"
                stroke="var(--accent)"
                strokeWidth="1.5"
              />
              <path d="M20 2V8H26" fill="var(--accent-subtle)" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" />
              <line x1="10" y1="14" x2="22" y2="14" stroke="var(--accent)" strokeWidth="1.2" strokeLinecap="round" opacity="0.5" />
              <line x1="10" y1="18" x2="19" y2="18" stroke="var(--accent)" strokeWidth="1.2" strokeLinecap="round" opacity="0.5" />
              <line x1="10" y1="22" x2="16" y2="22" stroke="var(--accent)" strokeWidth="1.2" strokeLinecap="round" opacity="0.5" />
            </svg>
            <span className="processing-dialog__percent">{Math.round(displayPercent)}%</span>
          </div>
        </div>

        {/* Phase info */}
        <h3 className="processing-dialog__title">{labels.title}</h3>
        <p className="processing-dialog__subtitle">{stalled ? stalledSubtitle : labels.subtitle}</p>

        {/* Filename pill */}
        <div className="processing-dialog__file">
          <span className="processing-dialog__format">{format}</span>
          <span className="processing-dialog__filename">{filename}</span>
        </div>

        {/* Pulsing dots */}
        <div className="processing-dialog__dots">
          <span className="processing-dialog__dot" />
          <span className="processing-dialog__dot" />
          <span className="processing-dialog__dot" />
        </div>

        {onCancel && (
          <button
            type="button"
            className="processing-dialog__cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
