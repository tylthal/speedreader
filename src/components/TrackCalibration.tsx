import { useState, useEffect, useRef, useCallback } from 'react';
import type { FaceLandmark } from '../hooks/useGazeTracker';
import { NOSE_TIP, FOREHEAD, drawMirroredVideo, drawFaceLandmarks } from '../lib/drawFaceLandmarks';

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
  const [faceMissing, setFaceMissing] = useState(false);
  const faceMissingRef = useRef(false);
  faceMissingRef.current = faceMissing;
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);
  const lastLandmarkAtRef = useRef(0);
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

      // Use native video resolution so nothing gets stretched
      const vw = video?.videoWidth || 320;
      const vh = video?.videoHeight || 240;

      if (video && videoCanvas && video.readyState >= 2) {
        const vCtx = videoCanvas.getContext('2d');
        if (vCtx) {
          if (videoCanvas.width !== vw) videoCanvas.width = vw;
          if (videoCanvas.height !== vh) videoCanvas.height = vh;
          drawMirroredVideo(vCtx, video, vw, vh);
        }
      }

      if (landmarkCanvas) {
        const ctx = landmarkCanvas.getContext('2d');
        if (ctx) {
          if (landmarkCanvas.width !== vw) landmarkCanvas.width = vw;
          if (landmarkCanvas.height !== vh) landmarkCanvas.height = vh;
          ctx.clearRect(0, 0, vw, vh);

          const landmarks = landmarksRef.current;
          if (landmarks && landmarks.length > 0) {
            lastLandmarkAtRef.current = Date.now();
            if (faceMissing) setFaceMissing(false);
            drawFaceLandmarks(ctx, landmarks, vw, vh, {
              ovalColor: 'rgba(120, 220, 255, 0.7)',
              eyeColor: 'rgba(120, 220, 255, 0.85)',
              noseColor: 'rgba(120, 220, 255, 1)',
              ovalWidth: 2.5,
              eyeWidth: 2,
              noseRadius: 5,
            });

            // Extra calibration-specific overlays: forehead + pitch axis line
            const lx = (lm: FaceLandmark) => (1 - lm.x) * vw;
            const ly = (lm: FaceLandmark) => lm.y * vh;
            const fh = landmarks[FOREHEAD];
            const nose = landmarks[NOSE_TIP];

            ctx.beginPath();
            ctx.arc(lx(fh), ly(fh), 4, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(120, 220, 255, 0.85)';
            ctx.fill();

            ctx.beginPath();
            ctx.moveTo(lx(fh), ly(fh));
            ctx.lineTo(lx(nose), ly(nose));
            ctx.strokeStyle = 'rgba(120, 220, 255, 0.5)';
            ctx.lineWidth = 1.5;
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
  }, [videoRef, landmarksRef, faceMissing]);

  // Watch for face-not-detected during point steps so we can hint the
  // user. Also pauses the progress timer while the face is missing so
  // we don't capture a non-face sample. Landmarks-never-seen is the
  // startup case — treat that as "not missing yet" so we give the
  // tracker a beat to wake up instead of flashing the hint on start.
  useEffect(() => {
    if (step !== 'top' && step !== 'center' && step !== 'bottom') return;
    // Prime the staleness reference on step entry so the first tick
    // doesn't see a 50-year-old timestamp.
    lastLandmarkAtRef.current = Date.now();
    const id = setInterval(() => {
      const stale = Date.now() - lastLandmarkAtRef.current > 500;
      if (stale && !faceMissing) {
        setFaceMissing(true);
        startTimeRef.current = Date.now() - progress * POINT_DURATION_MS;
      } else if (!stale && faceMissing) {
        setFaceMissing(false);
        startTimeRef.current = Date.now() - progress * POINT_DURATION_MS;
      }
    }, 150);
    return () => clearInterval(id);
  }, [step, faceMissing, progress]);

  // Animate progress ring during calibration points. faceMissing is
  // read via ref so a missed-face flicker doesn't re-run this effect
  // and reset progress to 0.
  useEffect(() => {
    if (step === 'top' || step === 'center' || step === 'bottom') {
      onCalibrateRef.current(step);
      setProgress(0);
      startTimeRef.current = Date.now();

      timerRef.current = setInterval(() => {
        if (faceMissingRef.current) return;
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

  const handleRestart = useCallback(() => {
    clearTimer();
    setProgress(0);
    setStep('intro');
  }, [clearTimer]);

  const handleCancel = useCallback(() => {
    clearTimer();
    onSkip();
  }, [clearTimer, onSkip]);

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
          <svg
            className="gaze-calibration__demo"
            viewBox="0 0 120 80"
            width="140"
            height="96"
            aria-hidden="true"
          >
            <g className="gaze-calibration__demo-head">
              <circle cx="60" cy="38" r="18" fill="none" stroke="currentColor" strokeWidth="2" />
              <circle cx="54" cy="36" r="1.8" fill="currentColor" />
              <circle cx="66" cy="36" r="1.8" fill="currentColor" />
              <path d="M54 46 Q60 49 66 46" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </g>
            <g opacity="0.5">
              <path d="M30 20 L24 14 L32 14 Z M24 14 L24 30" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M90 60 L96 66 L88 66 Z M96 66 L96 50" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </g>
          </svg>
          <p className="gaze-calibration__text">
            You&rsquo;ll nod to advance and tilt up to rewind.
          </p>
          <p className="gaze-calibration__text gaze-calibration__text--muted">
            Tilt toward each dot for 2 seconds. Natural tilts, not extreme.
            The camera feed never leaves this device.
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
          <div className="gaze-calibration__point-actions">
            <button
              type="button"
              className="gaze-calibration__point-action"
              onClick={handleRestart}
              aria-label="Restart calibration"
            >
              Restart
            </button>
            <button
              type="button"
              className="gaze-calibration__point-action gaze-calibration__point-action--danger"
              onClick={handleCancel}
              aria-label="Cancel calibration"
            >
              Cancel
            </button>
          </div>
          <span className="gaze-calibration__step-label">
            {currentPoint.label} ({stepIndex + 1}/3)
          </span>
          {faceMissing && (
            <div className="gaze-calibration__missing" role="status">
              Face not detected — check your lighting and frame your face.
            </div>
          )}
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
