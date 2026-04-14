import { useState, useEffect, useRef, useCallback } from 'react';
import type { FaceLandmark } from '../hooks/useGazeTracker';

interface TrackCalibrationProps {
  onComplete: () => void;
  onSkip: () => void;
  onCalibratePoint: (point: 'top' | 'center' | 'bottom') => void;
  onFinish: () => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  landmarksRef: React.RefObject<FaceLandmark[] | null>;
}

type CalibrationStep = 'intro' | 'top' | 'center' | 'bottom' | 'done';

const POINT_DURATION_MS = 2000;
const POINTS: { step: 'top' | 'center' | 'bottom'; label: string; position: string }[] = [
  { step: 'top', label: 'Tilt head up toward the dot', position: '15vh' },
  { step: 'center', label: 'Hold head level at the dot', position: '50vh' },
  { step: 'bottom', label: 'Tilt head down toward the dot', position: '85vh' },
];

/* Key landmark indices for visualization */
const FACE_OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
const LEFT_EYE = [33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246];
const RIGHT_EYE = [362,382,381,380,374,373,390,249,263,466,388,387,386,385,384,398];
const NOSE_TIP = 1;
const FOREHEAD = 10;

export default function TrackCalibration({
  onComplete,
  onSkip,
  onCalibratePoint,
  onFinish,
  videoRef,
  landmarksRef,
}: TrackCalibrationProps) {
  const [step, setStep] = useState<CalibrationStep>('intro');
  const [progress, setProgress] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoCanvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  // Stabilize callbacks in refs to avoid effect re-triggers
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const onCalibrateRef = useRef(onCalibratePoint);
  onCalibrateRef.current = onCalibratePoint;
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Draw video feed + landmarks onto canvases
  useEffect(() => {
    let running = true;

    const draw = () => {
      if (!running) return;

      const video = videoRef.current;
      const videoCanvas = videoCanvasRef.current;
      const landmarkCanvas = canvasRef.current;

      if (video && videoCanvas && video.readyState >= 2) {
        const vCtx = videoCanvas.getContext('2d');
        if (vCtx) {
          const w = videoCanvas.clientWidth;
          const h = videoCanvas.clientHeight;
          if (videoCanvas.width !== w) videoCanvas.width = w;
          if (videoCanvas.height !== h) videoCanvas.height = h;

          // Mirror the video horizontally (selfie view)
          vCtx.save();
          vCtx.translate(w, 0);
          vCtx.scale(-1, 1);
          vCtx.drawImage(video, 0, 0, w, h);
          vCtx.restore();
        }
      }

      if (landmarkCanvas) {
        const ctx = landmarkCanvas.getContext('2d');
        if (ctx) {
          const w = landmarkCanvas.clientWidth;
          const h = landmarkCanvas.clientHeight;
          if (landmarkCanvas.width !== w) landmarkCanvas.width = w;
          if (landmarkCanvas.height !== h) landmarkCanvas.height = h;
          ctx.clearRect(0, 0, w, h);

          const landmarks = landmarksRef.current;
          if (landmarks && landmarks.length > 0) {
            // Mirror x coordinates to match selfie view
            const lx = (lm: FaceLandmark) => (1 - lm.x) * w;
            const ly = (lm: FaceLandmark) => lm.y * h;

            // Draw face oval
            ctx.beginPath();
            ctx.strokeStyle = 'rgba(120, 200, 255, 0.4)';
            ctx.lineWidth = 1.5;
            const oval0 = landmarks[FACE_OVAL[0]];
            ctx.moveTo(lx(oval0), ly(oval0));
            for (let i = 1; i < FACE_OVAL.length; i++) {
              const lm = landmarks[FACE_OVAL[i]];
              ctx.lineTo(lx(lm), ly(lm));
            }
            ctx.closePath();
            ctx.stroke();

            // Draw eyes
            const drawEye = (indices: number[]) => {
              ctx.beginPath();
              ctx.strokeStyle = 'rgba(120, 200, 255, 0.6)';
              ctx.lineWidth = 1.5;
              const e0 = landmarks[indices[0]];
              ctx.moveTo(lx(e0), ly(e0));
              for (let i = 1; i < indices.length; i++) {
                const lm = landmarks[indices[i]];
                ctx.lineTo(lx(lm), ly(lm));
              }
              ctx.closePath();
              ctx.stroke();
            };
            drawEye(LEFT_EYE);
            drawEye(RIGHT_EYE);

            // Draw nose tip — key tracking point, brighter
            const nose = landmarks[NOSE_TIP];
            ctx.beginPath();
            ctx.arc(lx(nose), ly(nose), 4, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(120, 200, 255, 0.9)';
            ctx.fill();

            // Draw forehead point
            const fh = landmarks[FOREHEAD];
            ctx.beginPath();
            ctx.arc(lx(fh), ly(fh), 3, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(120, 200, 255, 0.6)';
            ctx.fill();

            // Draw a vertical line between forehead and nose to visualize pitch axis
            ctx.beginPath();
            ctx.moveTo(lx(fh), ly(fh));
            ctx.lineTo(lx(nose), ly(nose));
            ctx.strokeStyle = 'rgba(120, 200, 255, 0.3)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [videoRef, landmarksRef]);

  // Animate progress ring during calibration points
  useEffect(() => {
    if (step === 'top' || step === 'center' || step === 'bottom') {
      onCalibrateRef.current(step);
      setProgress(0);
      startTimeRef.current = Date.now();

      timerRef.current = setInterval(() => {
        const elapsed = Date.now() - startTimeRef.current;
        const pct = Math.min(1, elapsed / POINT_DURATION_MS);
        setProgress(pct);

        if (pct >= 1) {
          clearTimer();
          if (step === 'top') setStep('center');
          else if (step === 'center') setStep('bottom');
          else if (step === 'bottom') {
            onFinishRef.current();
            setStep('done');
            setTimeout(() => onCompleteRef.current(), 1000);
          }
        }
      }, 30);

      return clearTimer;
    }
  }, [step, clearTimer]);

  const currentPoint = POINTS.find(p => p.step === step);
  const stepIndex = POINTS.findIndex(p => p.step === step);

  return (
    <div className="gaze-calibration" role="dialog" aria-label="Head tracking calibration">
      {/* Camera feed background */}
      <canvas ref={videoCanvasRef} className="gaze-calibration__video-bg" />
      {/* Dim overlay on top of video */}
      <div className="gaze-calibration__dim" />
      {/* Landmark overlay */}
      <canvas ref={canvasRef} className="gaze-calibration__landmarks" />

      {step === 'intro' && (
        <div className="gaze-calibration__intro">
          <h2 className="gaze-calibration__title">Head Tracking Setup</h2>
          <p className="gaze-calibration__text">
            Tilt your head toward each dot for 2 seconds. Use comfortable, natural tilts — not extreme ones.
          </p>
          <p className="gaze-calibration__text gaze-calibration__text--muted">
            The overlay shows what the tracker sees. Your camera feed stays on this device.
          </p>
          <div className="gaze-calibration__buttons">
            <button
              className="gaze-calibration__btn gaze-calibration__btn--primary"
              onClick={() => setStep('top')}
            >
              Start
            </button>
            <button
              className="gaze-calibration__btn gaze-calibration__btn--secondary"
              onClick={onSkip}
            >
              Skip
            </button>
          </div>
        </div>
      )}

      {currentPoint && (
        <div className="gaze-calibration__point-screen">
          <span className="gaze-calibration__step-label">
            {currentPoint.label} ({stepIndex + 1}/3)
          </span>
          <div
            className="gaze-calibration__dot-container"
            style={{ top: currentPoint.position }}
          >
            <svg
              className="gaze-calibration__ring"
              viewBox="0 0 48 48"
              width="48"
              height="48"
            >
              <circle
                cx="24"
                cy="24"
                r="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                opacity="0.2"
              />
              <circle
                cx="24"
                cy="24"
                r="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeDasharray={`${2 * Math.PI * 20}`}
                strokeDashoffset={`${2 * Math.PI * 20 * (1 - progress)}`}
                strokeLinecap="round"
                className="gaze-calibration__ring-progress"
              />
            </svg>
            <div className="gaze-calibration__dot" />
          </div>
        </div>
      )}

      {step === 'done' && (
        <div className="gaze-calibration__done">
          <span className="gaze-calibration__check">&#10003;</span>
          <span className="gaze-calibration__done-text">Calibration complete</span>
        </div>
      )}
    </div>
  );
}
