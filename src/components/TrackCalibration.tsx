import { useState, useEffect, useRef, useCallback } from 'react';
import type { FaceLandmark } from '../hooks/useGazeTracker';
import { NOSE_TIP, FOREHEAD, syncCanvasSize, drawMirroredVideo, drawFaceLandmarks } from '../lib/drawFaceLandmarks';

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
          const { w, h } = syncCanvasSize(videoCanvas);
          drawMirroredVideo(vCtx, video, w, h);
        }
      }

      if (landmarkCanvas) {
        const ctx = landmarkCanvas.getContext('2d');
        if (ctx) {
          const { w, h } = syncCanvasSize(landmarkCanvas);
          ctx.clearRect(0, 0, w, h);

          const landmarks = landmarksRef.current;
          if (landmarks && landmarks.length > 0) {
            drawFaceLandmarks(ctx, landmarks, w, h, {
              ovalColor: 'rgba(120, 200, 255, 0.4)',
              eyeColor: 'rgba(120, 200, 255, 0.6)',
              noseColor: 'rgba(120, 200, 255, 0.9)',
              eyeWidth: 1.5,
              noseRadius: 4,
            });

            // Extra calibration-specific overlays: forehead + pitch axis line
            const lx = (lm: FaceLandmark) => (1 - lm.x) * w;
            const ly = (lm: FaceLandmark) => lm.y * h;
            const fh = landmarks[FOREHEAD];
            const nose = landmarks[NOSE_TIP];

            ctx.beginPath();
            ctx.arc(lx(fh), ly(fh), 3, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(120, 200, 255, 0.6)';
            ctx.fill();

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
