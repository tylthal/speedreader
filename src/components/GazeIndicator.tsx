import type { GazeDirection } from '../lib/gazeProcessor';
import type { GazeStatus } from '../hooks/useGazeTracker';

interface GazeIndicatorProps {
  direction: GazeDirection;
  intensity: number;
  status: GazeStatus;
  debugPitch?: number;
  debugNormalized?: number;
}

export default function GazeIndicator({ direction, intensity, status, debugPitch, debugNormalized }: GazeIndicatorProps) {
  const isActive = direction !== 'neutral' && status === 'tracking';
  const isLost = status === 'lost';
  const isCalibrating = status === 'calibrating';

  // Thumb vertical offset: 50% = center, 0% = top, 100% = bottom
  let thumbOffset = 50;
  if (direction === 'down') {
    thumbOffset = 50 + intensity * 40;
  } else if (direction === 'up') {
    thumbOffset = 50 - intensity * 40;
  }

  const thumbClass = [
    'gaze-indicator__thumb',
    isActive && 'gaze-indicator__thumb--active',
    isLost && 'gaze-indicator__thumb--lost',
    isCalibrating && 'gaze-indicator__thumb--calibrating',
  ].filter(Boolean).join(' ');

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
