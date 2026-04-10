import { useState, useRef, useCallback, useEffect } from 'react';
import { GazeProcessor, extractPitchFromMatrix, extractYawFromMatrix } from '../lib/gazeProcessor';
import type { GazeDirection, CalibrationData } from '../lib/gazeProcessor';

export type { GazeDirection } from '../lib/gazeProcessor';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type GazeStatus = 'idle' | 'requesting' | 'loading_model' | 'calibrating' | 'tracking' | 'lost' | 'error';

export interface GazeState {
  status: GazeStatus;
  direction: GazeDirection;
  intensity: number;
  confidence: number;
  error?: string;
  /** Raw pitch in degrees for debug display */
  debugPitch?: number;
  /** Normalized signal for debug display */
  debugNormalized?: number;
  /** Seconds remaining before resume (0 = not resuming) */
  resumeCountdown: number;
}

export interface GazeActions {
  start: () => Promise<boolean>;
  stop: () => void;
  startCalibration: () => void;
  calibratePoint: (point: 'top' | 'center' | 'bottom') => void;
  finishCalibration: () => void;
  setSensitivity: (value: number) => void;
  pauseTracking: () => void;
  resumeTracking: () => void;
}

const CALIBRATION_KEY = 'speedreader_gaze_calibration';
const FRAME_INTERVAL_MS = 66; // ~15 Hz
const BLINK_THRESHOLD_MS = 500;
const RESUME_DELAY_MS = 2000; // must track face for 2s before resuming

/* ------------------------------------------------------------------ */
/*  Hook — runs MediaPipe FaceMesh on the main thread at ~12 Hz       */
/* ------------------------------------------------------------------ */

export function useGazeTracker(): [GazeState, React.RefObject<{ direction: GazeDirection; intensity: number }>, GazeActions] {
  const [state, setState] = useState<GazeState>({
    status: 'idle',
    direction: 'neutral',
    intensity: 0,
    resumeCountdown: 0,
    confidence: 0,
  });

  // Ref for rAF-speed access (no re-renders)
  const gazeRef = useRef<{ direction: GazeDirection; intensity: number }>({
    direction: 'neutral',
    intensity: 0,
  });

  // Internal refs
  const landmarkerRef = useRef<import('@mediapipe/tasks-vision').FaceLandmarker | null>(null);
  const processorRef = useRef(new GazeProcessor());
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frameIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const frameInFlightRef = useRef(false);
  const frameCountRef = useRef(0);
  const enhanceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const enhanceCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const lastGazeTimestampRef = useRef(0);
  const lostTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStateUpdateRef = useRef(0);
  const mountedRef = useRef(true);
  const statusRef = useRef<GazeStatus>('idle');

  statusRef.current = state.status;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  /* ---- Throttled state update (4 Hz for UI) ---- */
  const debugRef = useRef({ pitch: 0, normalized: 0 });

  const updateGaze = useCallback((direction: GazeDirection, intensity: number, confidence: number, debugPitch?: number, debugNormalized?: number) => {
    gazeRef.current = { direction, intensity };
    if (debugPitch !== undefined) debugRef.current = { pitch: debugPitch, normalized: debugNormalized ?? 0 };

    const now = Date.now();
    if (now - lastStateUpdateRef.current < 250) return;
    lastStateUpdateRef.current = now;

    if (!mountedRef.current) return;
    setState({
      status: 'tracking', direction, intensity, confidence, resumeCountdown: 0,
      debugPitch: debugRef.current.pitch,
      debugNormalized: debugRef.current.normalized,
    });
  }, []);

  // Tracks when face reappeared after a loss, for resume delay
  const reacquiredAtRef = useRef(0);

  /* ---- Handle tracking loss (blinks, look-away) ---- */
  const handleLost = useCallback(() => {
    if (!mountedRef.current) return;
    const elapsed = Date.now() - lastGazeTimestampRef.current;

    if (elapsed < BLINK_THRESHOLD_MS) return; // blink — hold state

    // Immediately pause — zero gaze and mark as lost
    gazeRef.current = { direction: 'neutral', intensity: 0 };
    reacquiredAtRef.current = 0; // reset resume timer

    if (statusRef.current === 'tracking') {
      setState(prev => ({ ...prev, status: 'lost', direction: 'neutral', intensity: 0, resumeCountdown: 0 }));
    }
  }, []);

  /* ---- Process a single video frame ---- */
  const processFrame = useCallback(() => {
    const video = videoRef.current;
    const landmarker = landmarkerRef.current;
    if (!video || !landmarker || video.readyState < 2) return;
    if (frameInFlightRef.current) return;

    frameInFlightRef.current = true;
    try {
      // Draw frame to canvas with contrast/brightness enhancement for low light
      let inputSource: HTMLVideoElement | HTMLCanvasElement = video;
      if (enhanceCtxRef.current && enhanceCanvasRef.current) {
        const ctx = enhanceCtxRef.current;
        const canvas = enhanceCanvasRef.current;
        canvas.width = video.videoWidth || 320;
        canvas.height = video.videoHeight || 240;
        ctx.filter = 'brightness(1.3) contrast(1.4)';
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        ctx.filter = 'none';
        inputSource = canvas;
      }

      // VIDEO mode: pass timestamp for temporal tracking
      const now = performance.now();
      const result = landmarker.detectForVideo(inputSource, now);

      // Check for transformation matrix first (most reliable signal)
      const hasMatrix = result.facialTransformationMatrixes &&
          result.facialTransformationMatrixes.length > 0;
      const hasFace = result.faceLandmarks && result.faceLandmarks.length > 0;

      if (!hasMatrix && !hasFace) {
        handleLost();
        frameInFlightRef.current = false;
        return;
      }

      let pitchDeg = 0;

      if (hasMatrix) {
        const matrix = result.facialTransformationMatrixes![0].data;
        pitchDeg = extractPitchFromMatrix(matrix);

        // Check yaw — if head turned >25°, user is looking away
        const yawDeg = extractYawFromMatrix(matrix);
        if (Math.abs(yawDeg) > 25) {
          handleLost();
          frameInFlightRef.current = false;
          return;
        }
      } else if (hasFace) {
        // Fallback: estimate pitch from landmarks if matrix unavailable
        const lm = result.faceLandmarks![0];
        const noseTip = lm[1];
        const leftInner = lm[133];
        const rightInner = lm[362];
        const leftOuter = lm[33];
        const rightOuter = lm[263];
        const eyeLineY = (leftInner.y + rightInner.y) / 2;
        const eyeWidth = Math.sqrt(
          (leftOuter.x - rightOuter.x) ** 2 + (leftOuter.y - rightOuter.y) ** 2,
        );
        if (eyeWidth > 1e-6) {
          // Rough pitch estimate: nose-to-eyeline distance in degrees
          pitchDeg = ((noseTip.y - eyeLineY) / eyeWidth) * 60;
        }
      }

      const gazeResult = processorRef.current.processPitch(pitchDeg);

      if (import.meta.env.DEV && frameCountRef.current++ % 15 === 0) {
        console.log(`[Gaze] pitch=${pitchDeg.toFixed(1)}° norm=${gazeResult.rawNormalized.toFixed(2)} dir=${gazeResult.direction} int=${gazeResult.intensity.toFixed(3)} matrix=${hasMatrix}`);
      }

      lastGazeTimestampRef.current = Date.now();

      // If currently lost, require 2s of stable face detection before resuming
      if (statusRef.current === 'lost') {
        if (reacquiredAtRef.current === 0) {
          reacquiredAtRef.current = Date.now();
        }
        const reacquiredFor = Date.now() - reacquiredAtRef.current;
        const remaining = Math.max(0, Math.ceil((RESUME_DELAY_MS - reacquiredFor) / 1000));
        if (reacquiredFor < RESUME_DELAY_MS) {
          // Still waiting — update countdown
          gazeRef.current = { direction: 'neutral', intensity: 0 };
          setState(prev => {
            if (prev.resumeCountdown !== remaining) {
              return { ...prev, resumeCountdown: remaining };
            }
            return prev;
          });
          frameInFlightRef.current = false;
          return;
        }
        // 2 seconds of stable tracking — resume
        reacquiredAtRef.current = 0;
      }

      updateGaze(gazeResult.direction, gazeResult.intensity, gazeResult.confidence, pitchDeg, gazeResult.rawNormalized);
    } catch (err) {
      if (import.meta.env.DEV) console.warn('[Gaze] Frame processing error:', err);
      handleLost();
    }
    frameInFlightRef.current = false;
  }, [updateGaze, handleLost]);

  /* ---- Frame capture interval ---- */
  const startFrameCapture = useCallback(() => {
    if (frameIntervalRef.current) return;
    frameIntervalRef.current = setInterval(processFrame, FRAME_INTERVAL_MS);
  }, [processFrame]);

  const stopFrameCapture = useCallback(() => {
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    frameInFlightRef.current = false;
  }, []);

  /* ---- Start: request camera, load model. Returns true on success. ---- */
  const start = useCallback(async (): Promise<boolean> => {
    if (statusRef.current !== 'idle' && statusRef.current !== 'error') {
      if (import.meta.env.DEV) console.log('[Gaze] start() skipped — status is', statusRef.current);
      return false;
    }

    setState({ status: 'requesting', direction: 'neutral', intensity: 0, confidence: 0, resumeCountdown: 0 });

    if (!navigator.mediaDevices?.getUserMedia) {
      const msg = 'Camera not available. Ensure you are using HTTPS or localhost.';
      if (import.meta.env.DEV) console.error('[Gaze]', msg);
      setState({ status: 'error', direction: 'neutral', intensity: 0, confidence: 0, resumeCountdown: 0, error: msg });
      return false;
    }

    try {
      // 1. Request camera
      if (import.meta.env.DEV) console.log('[Gaze] Requesting camera access...');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 320 },
          height: { ideal: 240 },
          // Low-light optimizations
          autoGainControl: true,
          exposureMode: 'continuous',
          brightnessMode: 'continuous',
        } as MediaTrackConstraints,
        audio: false,
      });
      if (import.meta.env.DEV) console.log('[Gaze] Camera granted');

      if (!mountedRef.current) {
        stream.getTracks().forEach(t => t.stop());
        return false;
      }
      streamRef.current = stream;

      // 2. Create video element
      const video = document.createElement('video');
      video.srcObject = stream;
      video.setAttribute('playsinline', '');
      video.muted = true;
      videoRef.current = video;
      await video.play();

      if (!mountedRef.current) {
        stream.getTracks().forEach(t => t.stop());
        return false;
      }

      // 2b. Create enhancement canvas for low-light contrast boost
      const enhanceCanvas = document.createElement('canvas');
      const enhanceCtx = enhanceCanvas.getContext('2d', { willReadFrequently: false });
      enhanceCanvasRef.current = enhanceCanvas;
      enhanceCtxRef.current = enhanceCtx;

      // 3. Load MediaPipe FaceLandmarker (lazy import to avoid loading until needed)
      if (import.meta.env.DEV) console.log('[Gaze] Loading MediaPipe model...');
      setState(prev => ({ ...prev, status: 'loading_model' }));

      const MODEL_TIMEOUT_MS = 30000;
      const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');

      const loadWithTimeout = async (delegate: 'GPU' | 'CPU'): Promise<import('@mediapipe/tasks-vision').FaceLandmarker> => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Model load timed out (${delegate})`)), MODEL_TIMEOUT_MS);
        });

        try {
          if (import.meta.env.DEV) console.log(`[Gaze] Trying ${delegate} delegate...`);
          const vision = await Promise.race([
            FilesetResolver.forVisionTasks(
              'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
            ),
            timeoutPromise,
          ]);
          const lm = await Promise.race([
            FaceLandmarker.createFromOptions(vision, {
              baseOptions: {
                modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
                delegate,
              },
              runningMode: 'VIDEO',
              numFaces: 1,
              outputFacialTransformationMatrixes: true,
              outputFaceBlendshapes: false,
              minFaceDetectionConfidence: 0.5,
              minTrackingConfidence: 0.5,
            }),
            timeoutPromise,
          ]);
          clearTimeout(timeout);
          return lm;
        } catch (err) {
          clearTimeout(timeout);
          throw err;
        }
      };

      let landmarker: import('@mediapipe/tasks-vision').FaceLandmarker;
      try {
        landmarker = await loadWithTimeout('GPU');
      } catch (gpuErr) {
        if (!mountedRef.current) {
          stream.getTracks().forEach(t => t.stop());
          return false;
        }
        if (import.meta.env.DEV) console.warn('[Gaze] GPU delegate failed, falling back to CPU:', gpuErr);
        landmarker = await loadWithTimeout('CPU');
      }

      landmarkerRef.current = landmarker;
      if (import.meta.env.DEV) console.log('[Gaze] MediaPipe model loaded');

      if (!mountedRef.current) {
        landmarker.close();
        stream.getTracks().forEach(t => t.stop());
        return false;
      }

      // 4. Load saved calibration (must have top/bottom fields from v2 format)
      try {
        const saved = localStorage.getItem(CALIBRATION_KEY);
        if (saved) {
          const data = JSON.parse(saved);
          if (data.top !== undefined && data.bottom !== undefined) {
            processorRef.current.loadCalibration(data as CalibrationData);
          } else {
            // Old format — discard, will need recalibration
            localStorage.removeItem(CALIBRATION_KEY);
          }
        }
      } catch { /* ignore */ }

      // 5. Start frame capture
      lastGazeTimestampRef.current = Date.now();
      startFrameCapture();

      if (import.meta.env.DEV) console.log('[Gaze] Tracking started');
      setState({ status: 'tracking', direction: 'neutral', intensity: 0, confidence: 0, resumeCountdown: 0 });
      return true;
    } catch (err) {
      if (!mountedRef.current) return false;
      const message = err instanceof Error ? err.message : 'Camera access failed';
      if (import.meta.env.DEV) console.error('[Gaze] Start failed:', message);
      setState({ status: 'error', direction: 'neutral', intensity: 0, confidence: 0, resumeCountdown: 0, error: message });
      return false;
    }
  }, [startFrameCapture]);

  /* ---- Stop: release camera, dispose model ---- */
  const stop = useCallback(() => {
    stopFrameCapture();

    if (lostTimerRef.current) {
      clearTimeout(lostTimerRef.current);
      lostTimerRef.current = null;
    }

    if (landmarkerRef.current) {
      landmarkerRef.current.close();
      landmarkerRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
      videoRef.current = null;
    }

    enhanceCanvasRef.current = null;
    enhanceCtxRef.current = null;

    processorRef.current.reset();
    gazeRef.current = { direction: 'neutral', intensity: 0 };
    if (mountedRef.current) {
      setState({ status: 'idle', direction: 'neutral', intensity: 0, confidence: 0, resumeCountdown: 0 });
    }
  }, [stopFrameCapture]);

  /* ---- Calibration actions ---- */
  const startCalibration = useCallback(() => {
    setState(prev => ({ ...prev, status: 'calibrating' }));
  }, []);

  const calibratePoint = useCallback((point: 'top' | 'center' | 'bottom') => {
    processorRef.current.startCalibrationPoint(point);
  }, []);

  const finishCalibration = useCallback(() => {
    const data = processorRef.current.applyCalibration();
    try {
      localStorage.setItem(CALIBRATION_KEY, JSON.stringify(data));
    } catch { /* storage full */ }
    if (import.meta.env.DEV) console.log('[Gaze] Calibration applied:', data);
    setState(prev => ({ ...prev, status: 'tracking' }));
  }, []);

  const setSensitivity = useCallback((value: number) => {
    processorRef.current.sensitivity = Math.max(0.5, Math.min(3.0, value));
  }, []);

  /** Pause inference and video decoding (for when playback is paused) */
  const pauseTracking = useCallback(() => {
    stopFrameCapture();
    // Pause the video element to stop camera frame decoding entirely
    videoRef.current?.pause();
  }, [stopFrameCapture]);

  /** Resume inference and video decoding (for when playback resumes) */
  const resumeTracking = useCallback(() => {
    if (landmarkerRef.current && videoRef.current) {
      videoRef.current.play().then(() => {
        lastGazeTimestampRef.current = Date.now();
        startFrameCapture();
      }).catch(() => {});
    }
  }, [startFrameCapture]);

  /* ---- Cleanup on unmount ---- */
  useEffect(() => {
    return () => { stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- Pause frame capture on visibility hidden ---- */
  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) {
        stopFrameCapture();
      } else if (statusRef.current === 'tracking' || statusRef.current === 'lost') {
        startFrameCapture();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [stopFrameCapture, startFrameCapture]);

  const actions: GazeActions = {
    start,
    stop,
    startCalibration,
    calibratePoint,
    finishCalibration,
    setSensitivity,
    pauseTracking,
    resumeTracking,
  };

  return [state, gazeRef, actions];
}
