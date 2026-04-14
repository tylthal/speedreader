/**
 * Shared face landmark drawing utilities for camera preview canvases.
 * Used by GazeIndicator and TrackCalibration.
 */

import type { FaceLandmark } from '../hooks/useGazeTracker'

// MediaPipe FaceMesh landmark indices
export const FACE_OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109]
export const LEFT_EYE = [33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246]
export const RIGHT_EYE = [362,382,381,380,374,373,390,249,263,466,388,387,386,385,384,398]
export const NOSE_TIP = 1
export const FOREHEAD = 10

/** Sync a canvas element's buffer size to its CSS size. */
export function syncCanvasSize(canvas: HTMLCanvasElement, scale = 1): { w: number; h: number } {
  const w = canvas.clientWidth * scale
  const h = canvas.clientHeight * scale
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  return { w, h }
}

/** Draw a mirrored (selfie) video frame onto a canvas context. */
export function drawMirroredVideo(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  w: number,
  h: number,
): void {
  ctx.save()
  ctx.translate(w, 0)
  ctx.scale(-1, 1)
  ctx.drawImage(video, 0, 0, w, h)
  ctx.restore()
}

interface DrawLandmarksOptions {
  ovalColor?: string
  eyeColor?: string
  noseColor?: string
  ovalWidth?: number
  eyeWidth?: number
  noseRadius?: number
}

/**
 * Draw face oval, eyes, and nose tip onto a canvas.
 * Coordinates are mirrored horizontally for selfie view.
 */
export function drawFaceLandmarks(
  ctx: CanvasRenderingContext2D,
  landmarks: FaceLandmark[],
  w: number,
  h: number,
  opts: DrawLandmarksOptions = {},
): void {
  const {
    ovalColor = 'rgba(120, 200, 255, 0.35)',
    eyeColor = 'rgba(120, 200, 255, 0.5)',
    noseColor = 'rgba(120, 200, 255, 0.8)',
    ovalWidth = 1.5,
    eyeWidth = 1,
    noseRadius = 3,
  } = opts

  const lx = (lm: FaceLandmark) => (1 - lm.x) * w
  const ly = (lm: FaceLandmark) => lm.y * h

  // Face oval
  ctx.beginPath()
  ctx.strokeStyle = ovalColor
  ctx.lineWidth = ovalWidth
  const o0 = landmarks[FACE_OVAL[0]]
  ctx.moveTo(lx(o0), ly(o0))
  for (let i = 1; i < FACE_OVAL.length; i++) {
    ctx.lineTo(lx(landmarks[FACE_OVAL[i]]), ly(landmarks[FACE_OVAL[i]]))
  }
  ctx.closePath()
  ctx.stroke()

  // Eyes
  const drawEye = (indices: number[]) => {
    ctx.beginPath()
    ctx.strokeStyle = eyeColor
    ctx.lineWidth = eyeWidth
    ctx.moveTo(lx(landmarks[indices[0]]), ly(landmarks[indices[0]]))
    for (let i = 1; i < indices.length; i++) {
      ctx.lineTo(lx(landmarks[indices[i]]), ly(landmarks[indices[i]]))
    }
    ctx.closePath()
    ctx.stroke()
  }
  drawEye(LEFT_EYE)
  drawEye(RIGHT_EYE)

  // Nose tip
  const nose = landmarks[NOSE_TIP]
  ctx.beginPath()
  ctx.arc(lx(nose), ly(nose), noseRadius, 0, Math.PI * 2)
  ctx.fillStyle = noseColor
  ctx.fill()
}
