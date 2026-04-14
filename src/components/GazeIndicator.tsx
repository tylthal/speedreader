import { useEffect, useRef } from 'react';
import type { GazeDirection } from '../lib/gazeProcessor';
import type { GazeStatus } from '../hooks/useGazeTracker';
import { drawCroppedFaceVideo, drawFaceLandmarks, drawFaceMesh, transformLandmarksToCrop } from '../lib/drawFaceLandmarks';
import type { FaceLandmark } from '../hooks/useGazeTracker';

interface GazeIndicatorProps {
  direction: GazeDirection;
  intensity: number;
  status: GazeStatus;
  debugPitch?: number;
  debugNormalized?: number;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  landmarksRef?: React.RefObject<FaceLandmark[] | null>;
}

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
      const landmarks = landmarksRef!.current;

      // Use a fixed canvas size for the small preview (sharper than CSS scaling)
      const canvasW = 144;
      const canvasH = 144;

      if (video && vc && video.readyState >= 2) {
        const ctx = vc.getContext('2d');
        if (ctx) {
          if (vc.width !== canvasW) vc.width = canvasW;
          if (vc.height !== canvasH) vc.height = canvasH;
          // Draw video cropped to the face region
          drawCroppedFaceVideo(ctx, video, landmarks, canvasW, canvasH);
        }
      }

      if (lc) {
        const ctx = lc.getContext('2d');
        if (ctx) {
          if (lc.width !== canvasW) lc.width = canvasW;
          if (lc.height !== canvasH) lc.height = canvasH;
          ctx.clearRect(0, 0, canvasW, canvasH);
          if (landmarks && landmarks.length > 0 && video) {
            // Transform landmarks to match the cropped view
            const result = transformLandmarksToCrop(landmarks, video.videoWidth || 320, video.videoHeight || 240);
            if (result) {
              // Wire-mask mesh first (behind the feature lines)
              drawFaceMesh(ctx, result.landmarks, canvasW, canvasH);
              // Feature lines on top: face oval, eyes, nose dot
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
