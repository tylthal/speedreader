/**
 * Head-pitch gaze processor using MediaPipe's facial transformation
 * matrix for reliable pitch extraction in degrees. Uses a square-root
 * intensity curve for strong response to small tilts.
 */

export interface CalibrationData {
  /** Pitch in degrees when looking at center target */
  center: number;
  /** Pitch in degrees when tilting up */
  top: number;
  /** Pitch in degrees when tilting down */
  bottom: number;
  timestamp: number;
}

export type GazeDirection = 'up' | 'neutral' | 'down';

export interface GazeResult {
  direction: GazeDirection;
  /** 0-1 intensity (sqrt-curved) */
  intensity: number;
  confidence: number;
  /** -1 to +1 raw normalized signal */
  rawNormalized: number;
}

/* ------------------------------------------------------------------ */
/*  1-Euro Filter                                                      */
/* ------------------------------------------------------------------ */

export class OneEuroFilter {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;

  constructor(minCutoff = 1.0, beta = 0.05, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  private smoothingFactor(cutoff: number, dt: number): number {
    const r = 2 * Math.PI * cutoff * dt;
    return r / (r + 1);
  }

  filter(x: number, timestamp: number): number {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = timestamp;
      return x;
    }

    const dt = Math.max((timestamp - this.tPrev) / 1000, 1e-6);
    this.tPrev = timestamp;

    const dx = (x - this.xPrev) / dt;
    const aD = this.smoothingFactor(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    this.dxPrev = dxHat;

    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = this.smoothingFactor(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;

    return xHat;
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = 0;
  }
}

/* ------------------------------------------------------------------ */
/*  Pitch extraction from transformation matrix                        */
/* ------------------------------------------------------------------ */

/**
 * Extract pitch angle (head nod) in degrees from a MediaPipe 4x4
 * facial transformation matrix (column-major flat array of 16 floats).
 *
 * Uses ZYX Euler decomposition:
 *   pitch (X-axis rotation, nod) = atan2(R[2][1], R[2][2])
 *   yaw   (Y-axis rotation, turn) = atan2(-R[2][0], sqrt(R[2][1]²+R[2][2]²))
 *   roll  (Z-axis rotation, tilt) = atan2(R[1][0], R[0][0])
 *
 * Positive pitch = head tilted down, negative = head tilted up.
 */
export function extractPitchFromMatrix(matrix: Float32Array | number[]): number {
  // Column-major: R[row][col] = matrix[col * 4 + row]
  const r21 = matrix[6];   // R[2][1]
  const r22 = matrix[10];  // R[2][2]

  const pitch = Math.atan2(r21, r22); // radians, rotation around X axis

  return pitch * (180 / Math.PI); // degrees
}

/**
 * Extract yaw angle (head turn left/right) in degrees.
 * Large absolute yaw = user turned away from screen.
 */
export function extractYawFromMatrix(matrix: Float32Array | number[]): number {
  const r20 = matrix[2];   // R[2][0]
  const r21 = matrix[6];   // R[2][1]
  const r22 = matrix[10];  // R[2][2]

  const sy = Math.sqrt(r21 * r21 + r22 * r22);
  const yaw = Math.atan2(-r20, sy);

  return yaw * (180 / Math.PI);
}

/* ------------------------------------------------------------------ */
/*  GazeProcessor                                                      */
/* ------------------------------------------------------------------ */

export class GazeProcessor {
  private filter = new OneEuroFilter(0.4, 0.08, 1.0);

  private calTop = -10;   // degrees when tilting up (default: -10°)
  private calCenter = 0;  // degrees at neutral
  private calBottom = 10; // degrees when tilting down (default: +10°)
  private isCalibrated = false;

  /** Effective ranges after balancing (degrees, always positive) */
  private effectiveUpRange = 10;
  private effectiveDownRange = 10;

  /** User-adjustable sensitivity multiplier (1.0 = default) */
  sensitivity = 1.0;

  /** Dead zone half-width on the normalized -1..+1 scale */
  deadZone = 0.35;

  /** Per-direction dead zones (computed from range ratio after calibration) */
  private upDeadZone = 0.35;
  private downDeadZone = 0.35;

  /** Hysteresis: once in neutral, need to exceed this to leave.
   *  Once active, only need to drop below deadZone to return. */
  private hysteresis = 0.08;
  private wasActive = false;

  private calibrationSamples = new Map<string, number[]>();
  private currentCalPoint: string | null = null;

  /** Minimum calibration range in degrees per direction */
  private static MIN_RANGE_DEG = 3;
  /** Smaller range must be at least this fraction of larger range */
  private static MIN_RANGE_RATIO = 0.4;

  /**
   * Process a pitch angle (degrees) into a gaze result.
   * Call this with the pitch extracted from the transformation matrix.
   */
  processPitch(pitchDegrees: number): GazeResult {
    const now = Date.now();
    const smoothed = this.filter.filter(pitchDegrees, now);

    // Accumulate calibration samples
    if (this.currentCalPoint) {
      const samples = this.calibrationSamples.get(this.currentCalPoint);
      if (samples && samples.length < 30) {
        samples.push(smoothed);
      }
    }

    const normalized = this.normalize(smoothed);
    const adjusted = normalized * this.sensitivity;
    const { direction, intensity } = this.classify(adjusted);

    return { direction, intensity, confidence: 0.95, rawNormalized: adjusted };
  }

  private normalize(pitch: number): number {
    if (!this.isCalibrated) {
      // Without calibration, assume ±10° range from center
      return (pitch - this.calCenter) / 10;
    }

    // Map calibrated range to -1..+1 using effective (balanced) ranges
    if (pitch < this.calCenter) {
      // Tilting up (pitch goes negative)
      return -((this.calCenter - pitch) / this.effectiveUpRange);
    } else {
      // Tilting down (pitch goes positive)
      return (pitch - this.calCenter) / this.effectiveDownRange;
    }
  }

  private classify(normalized: number): { direction: GazeDirection; intensity: number } {
    const abs = Math.abs(normalized);

    // Use per-direction dead zone so the direction with a smaller
    // calibration range gets a wider dead zone (less sensitive)
    const dirDeadZone = normalized < 0 ? this.upDeadZone : this.downDeadZone;

    // Hysteresis: use a wider threshold to leave neutral, narrower to return
    const threshold = this.wasActive
      ? dirDeadZone                          // easy to stay active
      : dirDeadZone + this.hysteresis;       // harder to leave neutral

    if (abs <= threshold) {
      this.wasActive = false;
      return { direction: 'neutral', intensity: 0 };
    }

    this.wasActive = true;

    // Smoothstep curve from the threshold edge
    // so intensity ramps smoothly from 0 once past the threshold
    const beyondDeadZone = (abs - threshold) / (1 - threshold);
    const t = Math.min(1, Math.max(0, beyondDeadZone));
    const intensity = t * t * (3 - 2 * t); // smoothstep: 3t² - 2t³

    return {
      direction: normalized < 0 ? 'up' : 'down',
      intensity,
    };
  }

  startCalibrationPoint(point: string): void {
    this.currentCalPoint = point;
    this.calibrationSamples.set(point, []);
  }

  applyCalibration(): CalibrationData {
    this.currentCalPoint = null;

    const topSamples = this.calibrationSamples.get('top') ?? [];
    const centerSamples = this.calibrationSamples.get('center') ?? [];
    const bottomSamples = this.calibrationSamples.get('bottom') ?? [];

    const avgArr = (arr: number[]) =>
      arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const avgTop = avgArr(topSamples);
    const avgCenter = avgArr(centerSamples);
    const avgBottom = avgArr(bottomSamples);

    if (import.meta.env.DEV) {
      console.log('[Head Pitch Cal] top:', avgTop.toFixed(2) + '°',
        'center:', avgCenter.toFixed(2) + '°', 'bottom:', avgBottom.toFixed(2) + '°');
    }

    if (topSamples.length >= 3 && centerSamples.length >= 3 && bottomSamples.length >= 3) {
      this.calTop = avgTop;
      this.calCenter = avgCenter;
      this.calBottom = avgBottom;
      this.isCalibrated = true;
      this.computeEffectiveRanges();
    }

    this.calibrationSamples.clear();
    this.filter.reset();

    return { center: this.calCenter, top: this.calTop, bottom: this.calBottom, timestamp: Date.now() };
  }

  loadCalibration(data: CalibrationData): void {
    this.calCenter = data.center;
    this.calTop = data.top;
    this.calBottom = data.bottom;
    this.isCalibrated = true;
    this.computeEffectiveRanges();
    this.filter.reset();
  }

  /**
   * Compute effective ranges and per-direction dead zones from
   * calibration data. Handles asymmetric phone positions by:
   *  1. Enforcing a minimum range per direction (MIN_RANGE_DEG)
   *  2. Ensuring the smaller range is at least MIN_RANGE_RATIO of the larger
   *  3. Widening the dead zone for the direction with smaller range
   */
  private computeEffectiveRanges(): void {
    let rawUp = Math.abs(this.calCenter - this.calTop);
    let rawDown = Math.abs(this.calBottom - this.calCenter);

    // Enforce minimum range
    rawUp = Math.max(rawUp, GazeProcessor.MIN_RANGE_DEG);
    rawDown = Math.max(rawDown, GazeProcessor.MIN_RANGE_DEG);

    // Balance ranges: smaller must be at least MIN_RANGE_RATIO of larger
    const larger = Math.max(rawUp, rawDown);
    const minAllowed = larger * GazeProcessor.MIN_RANGE_RATIO;
    rawUp = Math.max(rawUp, minAllowed);
    rawDown = Math.max(rawDown, minAllowed);

    this.effectiveUpRange = rawUp;
    this.effectiveDownRange = rawDown;

    // Compute asymmetric dead zones: the direction with a smaller
    // calibrated range gets a proportionally wider dead zone.
    // This prevents the tighter direction from being over-sensitive.
    const ratio = Math.min(rawUp, rawDown) / Math.max(rawUp, rawDown);
    // ratio is 0.4..1.0. When ranges are equal (ratio=1), both dead zones = base.
    // When one is much smaller (ratio→0.4), that direction's dead zone widens.
    const bonusDeadZone = (1 - ratio) * 0.15; // up to 0.15 extra dead zone

    if (rawUp <= rawDown) {
      this.upDeadZone = this.deadZone + bonusDeadZone;
      this.downDeadZone = this.deadZone;
    } else {
      this.upDeadZone = this.deadZone;
      this.downDeadZone = this.deadZone + bonusDeadZone;
    }

    if (import.meta.env.DEV) {
      console.log('[Head Pitch Cal] effective ranges — up:', rawUp.toFixed(1) + '°',
        'down:', rawDown.toFixed(1) + '°',
        '| dead zones — up:', this.upDeadZone.toFixed(2),
        'down:', this.downDeadZone.toFixed(2));
    }
  }

  reset(): void {
    this.filter.reset();
    this.calibrationSamples.clear();
    this.currentCalPoint = null;
    this.calCenter = 0;
    this.calTop = -10;
    this.calBottom = 10;
    this.isCalibrated = false;
    this.effectiveUpRange = 10;
    this.effectiveDownRange = 10;
    this.sensitivity = 1.0;
    this.deadZone = 0.35;
    this.upDeadZone = 0.35;
    this.downDeadZone = 0.35;
    this.wasActive = false;
  }
}
