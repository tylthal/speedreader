import { useEffect, useRef } from 'react';
import type { GazeDirection } from '../lib/gazeProcessor';
import type { GazeStatus } from '../hooks/useGazeTracker';
import { drawFaceLandmarks, drawFaceMesh, transformLandmarksToCrop } from '../lib/drawFaceLandmarks';
import type { FaceLandmark } from '../hooks/useGazeTracker';

interface GazeIndicatorProps {
  direction: GazeDirection;
  intensity: number;
  status: GazeStatus;
  debugPitch?: number;
  debugNormalized?: number;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  landmarksRef?: React.RefObject<FaceLandmark[] | null>;
  /** Live-updating ref — when present, thumb position is driven imperatively
   * at ~15Hz from this ref instead of from props. Avoids per-tick re-renders. */
  gazeRef?: React.RefObject<{ direction: GazeDirection; intensity: number }>;
}

// Hands-free/track mode — match the FaceLandmarker inference rate.
const HUD_FRAME_INTERVAL_MS = 66;

function computeThumbOffset(direction: GazeDirection, intensity: number): number {
  if (direction === 'down') return 50 + intensity * 40;
  if (direction === 'up') return 50 - intensity * 40;
  return 50;
}

export default function GazeIndicator({
  direction,
  intensity,
  status,
  videoRef,
  landmarksRef,
  gazeRef,
}: GazeIndicatorProps) {
  const isActive = direction !== 'neutral' && status === 'tracking';
  const isLost = status === 'lost';
  const isCalibrating = status === 'calibrating';
  const hasCamera = !!videoRef && !!landmarksRef;

  const videoCanvasRef = useRef<HTMLCanvasElement>(null);
  const landmarkCanvasRef = useRef<HTMLCanvasElement>(null);
  const thumbDomRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const lastDrawRef = useRef(0);
  const lastLandmarksRef = useRef<FaceLandmark[] | null>(null);

  // Single throttled rAF loop: updates the thumb position imperatively from
  // gazeRef (no re-render) and redraws the landmark canvas only when the
  // underlying landmark array changes. Scheduled at ~15Hz to match the
  // FaceLandmarker inference cadence — drawing any faster just burns the
  // main thread between inferences.
  useEffect(() => {
    if (!hasCamera && !gazeRef) return;
    let running = true;

    const tick = (now: number) => {
      if (!running) return;
      rafRef.current = requestAnimationFrame(tick);

      if (now - lastDrawRef.current < HUD_FRAME_INTERVAL_MS) return;
      lastDrawRef.current = now;

      // Imperative thumb update — avoids React re-render during tracking.
      if (gazeRef && thumbDomRef.current) {
        const { direction: d, intensity: i } = gazeRef.current;
        thumbDomRef.current.style.top = `${computeThumbOffset(d, i)}%`;
      }

      // Landmark canvas — redraw only when the landmark array reference changes.
      if (hasCamera) {
        const video = videoRef!.current;
        const vc = videoCanvasRef.current;
        const lc = landmarkCanvasRef.current;
        const landmarks = landmarksRef!.current;
        const canvasW = 144;
        const canvasH = 144;

        if (vc) {
          const ctx = vc.getContext('2d');
          if (ctx) {
            if (vc.width !== canvasW) vc.width = canvasW;
            if (vc.height !== canvasH) vc.height = canvasH;
            ctx.clearRect(0, 0, canvasW, canvasH);
          }
        }

        if (lc && landmarks !== lastLandmarksRef.current) {
          lastLandmarksRef.current = landmarks;
          const ctx = lc.getContext('2d');
          if (ctx) {
            if (lc.width !== canvasW) lc.width = canvasW;
            if (lc.height !== canvasH) lc.height = canvasH;
            ctx.clearRect(0, 0, canvasW, canvasH);
            if (landmarks && landmarks.length > 0 && video) {
              const result = transformLandmarksToCrop(landmarks, video.videoWidth || 320, video.videoHeight || 240);
              if (result) {
                drawFaceMesh(ctx, result.landmarks, canvasW, canvasH);
                drawFaceLandmarks(ctx, result.landmarks, canvasW, canvasH, {
                  ovalColor: 'rgba(120, 220, 255, 0.7)',
                  eyeColor: 'rgba(120, 220, 255, 0.85)',
                  noseColor: 'rgba(120, 220, 255, 1)',
                  ovalWidth: 2.5,
                  eyeWidth: 2,
                  noseRadius: 5,
                });
              }
            }
          }
        }
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
      lastLandmarksRef.current = null;
    };
  }, [hasCamera, videoRef, landmarksRef, gazeRef]);

  // Initial thumb position — used when gazeRef isn't provided, and as the
  // first-paint value before the rAF loop runs.
  const thumbOffset = computeThumbOffset(direction, intensity);

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
              ref={thumbDomRef}
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
          ref={thumbDomRef}
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
