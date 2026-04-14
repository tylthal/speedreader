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

/**
 * Compute a face bounding box from landmarks with padding, suitable for
 * cropping the video to a face close-up.  Returns source rect in video-pixel
 * coordinates (already mirror-flipped for selfie view) and keeps the crop
 * square so the preview doesn't distort.
 */
export function computeFaceCropRect(
  landmarks: FaceLandmark[],
  videoWidth: number,
  videoHeight: number,
  padding = 0.35,
): { sx: number; sy: number; sw: number; sh: number } | null {
  if (!landmarks || landmarks.length === 0) return null

  // Use face oval landmarks to find the bounding box
  let minX = 1, maxX = 0, minY = 1, maxY = 0
  for (const idx of FACE_OVAL) {
    const lm = landmarks[idx]
    if (!lm) continue
    if (lm.x < minX) minX = lm.x
    if (lm.x > maxX) maxX = lm.x
    if (lm.y < minY) minY = lm.y
    if (lm.y > maxY) maxY = lm.y
  }

  // Expand by padding factor
  const faceW = maxX - minX
  const faceH = maxY - minY
  const padX = faceW * padding
  const padY = faceH * padding

  let x1 = minX - padX
  let y1 = minY - padY
  let x2 = maxX + padX
  let y2 = maxY + padY

  // Make it square (use the larger dimension)
  const cropW = x2 - x1
  const cropH = y2 - y1
  if (cropW > cropH) {
    const diff = (cropW - cropH) / 2
    y1 -= diff
    y2 += diff
  } else {
    const diff = (cropH - cropW) / 2
    x1 -= diff
    x2 += diff
  }

  // Clamp to [0, 1]
  x1 = Math.max(0, x1)
  y1 = Math.max(0, y1)
  x2 = Math.min(1, x2)
  y2 = Math.min(1, y2)

  // Mirror x for selfie view (landmarks are in non-mirrored space)
  const sx = (1 - x2) * videoWidth
  const sy = y1 * videoHeight
  const sw = (x2 - x1) * videoWidth
  const sh = (y2 - y1) * videoHeight

  return { sx, sy, sw, sh }
}

/**
 * Draw a mirrored video frame cropped to the face region.
 * Falls back to full-frame if no landmarks available.
 */
export function drawCroppedFaceVideo(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  landmarks: FaceLandmark[] | null,
  w: number,
  h: number,
): void {
  const crop = landmarks ? computeFaceCropRect(landmarks, video.videoWidth, video.videoHeight) : null

  if (crop) {
    // Draw the cropped region scaled to fill the canvas
    ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h)
  } else {
    // Fallback: full mirrored frame
    drawMirroredVideo(ctx, video, w, h)
  }
}

/**
 * Transform landmark coordinates into cropped-face-relative coordinates.
 * Returns adjusted landmarks array for drawing on a cropped canvas.
 */
export function transformLandmarksToCrop(
  landmarks: FaceLandmark[],
  videoWidth: number,
  videoHeight: number,
): { landmarks: FaceLandmark[]; cropRect: { sx: number; sy: number; sw: number; sh: number } } | null {
  const crop = computeFaceCropRect(landmarks, videoWidth, videoHeight)
  if (!crop) return null

  // Convert each landmark to cropped coordinates
  // Landmarks are in normalized [0,1] video space, mirrored x = (1 - lm.x)
  const transformed = landmarks.map(lm => {
    const mirroredX = (1 - lm.x) * videoWidth
    const pixelY = lm.y * videoHeight
    return {
      // Convert back to normalized coords relative to the crop rect
      // But we need to un-mirror since drawFaceLandmarks will re-mirror
      x: 1 - ((mirroredX - crop.sx) / crop.sw),
      y: (pixelY - crop.sy) / crop.sh,
      z: lm.z,
    }
  })

  return { landmarks: transformed, cropRect: crop }
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
