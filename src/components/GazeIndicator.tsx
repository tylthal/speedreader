import { useEffect, useRef } from 'react';
import type { GazeDirection } from '../lib/gazeProcessor';
import type { GazeStatus, FaceLandmark } from '../hooks/useGazeTracker';

interface GazeIndicatorProps {
  direction: GazeDirection;
  intensity: number;
  status: GazeStatus;
  debugPitch?: number;
  debugNormalized?: number;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  landmarksRef?: React.RefObject<FaceLandmark[] | null>;
}

/* Key landmark indices — same as TrackCalibration */
const FACE_OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
const LEFT_EYE = [33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246];
const RIGHT_EYE = [362,382,381,380,374,373,390,249,263,466,388,387,386,385,384,398];
const NOSE_TIP = 1;

export default function GazeIndicator({ direction, intensity, status, videoRef, landmarksRef }: GazeIndicatorProps) {
  const isActive = direction !== 'neutral' && status === 'tracking';
  const isLost = status === 'lost';
  const isCalibrating = status === 'calibrating';
  const hasCamera = !!videoRef && !!landmarksRef;

  const videoCanvasRef = useRef<HTMLCanvasElement>(null);
  const landmarkCanvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  // Thumb vertical offset: 50% = center, 0% = top, 100% = bottom
  let thumbOffset = 50;
  if (direction === 'down') {
    thumbOffset = 50 + intensity * 40;
  } else if (direction === 'up') {
    thumbOffset = 50 - intensity * 40;
  }

  // Draw camera feed + landmarks into the small preview
  useEffect(() => {
    if (!hasCamera) return;
    let running = true;

    const draw = () => {
      if (!running) return;
      const video = videoRef!.current;
      const vc = videoCanvasRef.current;
      const lc = landmarkCanvasRef.current;

      if (video && vc && video.readyState >= 2) {
        const ctx = vc.getContext('2d');
        if (ctx) {
          const w = vc.clientWidth * 2; // 2x for retina
          const h = vc.clientHeight * 2;
          if (vc.width !== w) vc.width = w;
          if (vc.height !== h) vc.height = h;
          ctx.save();
          ctx.translate(w, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(video, 0, 0, w, h);
          ctx.restore();
        }
      }

      if (lc) {
        const ctx = lc.getContext('2d');
        if (ctx) {
          const w = lc.clientWidth * 2;
          const h = lc.clientHeight * 2;
          if (lc.width !== w) lc.width = w;
          if (lc.height !== h) lc.height = h;
          ctx.clearRect(0, 0, w, h);

          const landmarks = landmarksRef!.current;
          if (landmarks && landmarks.length > 0) {
            const lx = (lm: FaceLandmark) => (1 - lm.x) * w;
            const ly = (lm: FaceLandmark) => lm.y * h;

            // Face oval
            ctx.beginPath();
            ctx.strokeStyle = 'rgba(120, 200, 255, 0.35)';
            ctx.lineWidth = 1.5;
            const o0 = landmarks[FACE_OVAL[0]];
            ctx.moveTo(lx(o0), ly(o0));
            for (let i = 1; i < FACE_OVAL.length; i++) {
              ctx.lineTo(lx(landmarks[FACE_OVAL[i]]), ly(landmarks[FACE_OVAL[i]]));
            }
            ctx.closePath();
            ctx.stroke();

            // Eyes
            const drawEye = (indices: number[]) => {
              ctx.beginPath();
              ctx.strokeStyle = 'rgba(120, 200, 255, 0.5)';
              ctx.lineWidth = 1;
              ctx.moveTo(lx(landmarks[indices[0]]), ly(landmarks[indices[0]]));
              for (let i = 1; i < indices.length; i++) {
                ctx.lineTo(lx(landmarks[indices[i]]), ly(landmarks[indices[i]]));
              }
              ctx.closePath();
              ctx.stroke();
            };
            drawEye(LEFT_EYE);
            drawEye(RIGHT_EYE);

            // Nose tip
            const nose = landmarks[NOSE_TIP];
            ctx.beginPath();
            ctx.arc(lx(nose), ly(nose), 3, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(120, 200, 255, 0.8)';
            ctx.fill();
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
  }, [hasCamera, videoRef, landmarksRef]);

  const thumbClass = [
    'gaze-indicator__thumb',
    isActive && 'gaze-indicator__thumb--active',
    isLost && 'gaze-indicator__thumb--lost',
    isCalibrating && 'gaze-indicator__thumb--calibrating',
  ].filter(Boolean).join(' ');

  // Camera HUD version
  if (hasCamera) {
    return (
      <div
        className="gaze-hud"
        role="status"
        aria-label={
          isLost ? 'Head tracking lost'
            : isCalibrating ? 'Calibrating head tracking'
            : `Gaze direction: ${direction}`
        }
      >
        <div className="gaze-hud__camera">
          <canvas ref={videoCanvasRef} className="gaze-hud__video" />
          <canvas ref={landmarkCanvasRef} className="gaze-hud__landmarks" />
          {isLost && <div className="gaze-hud__lost-badge">Lost</div>}
        </div>
        <div className="gaze-hud__bar">
          <div className="gaze-hud__bar-track">
            <div className="gaze-hud__bar-zone gaze-hud__bar-zone--up" />
            <div className="gaze-hud__bar-zone gaze-hud__bar-zone--dead" />
            <div className="gaze-hud__bar-zone gaze-hud__bar-zone--down" />
            <div
              className={[
                'gaze-hud__bar-thumb',
                isActive && 'gaze-hud__bar-thumb--active',
                isLost && 'gaze-hud__bar-thumb--lost',
              ].filter(Boolean).join(' ')}
              style={{ top: `${thumbOffset}%` }}
            />
          </div>
          <div className="gaze-hud__bar-labels">
            <span>Up</span>
            <span>Down</span>
          </div>
        </div>
      </div>
    );
  }

  // Fallback: original minimal indicator (no camera refs available)
  return (
    <div
      className="gaze-indicator"
      role="status"
      aria-label={
        isLost
          ? 'Head tracking lost'
          : isCalibrating
          ? 'Calibrating head tracking'
          : `Gaze direction: ${direction}`
      }
    >
      <div className="gaze-indicator__track">
        <div
          className={thumbClass}
          style={{ top: `${thumbOffset}%` }}
        />
      </div>
      {isLost && (
        <span className="gaze-indicator__label">Tracking paused</span>
      )}
    </div>
  );
}
