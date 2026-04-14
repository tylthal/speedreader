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

/* ================================================================== */
/*  Wire-mask mesh: low-poly triangulated face overlay                */
/* ================================================================== */

// Key structural landmark indices (MediaPipe FaceMesh 468-point model)
const LM_FOREHEAD_TOP    = 10
const LM_FOREHEAD_L      = 67
const LM_FOREHEAD_R      = 297
const LM_BROW_CENTER     = 9
const LM_TEMPLE_L        = 127
const LM_TEMPLE_R        = 356
const LM_CHEEKBONE_L     = 116
const LM_CHEEKBONE_R     = 345
const LM_JAW_L           = 172
const LM_JAW_R           = 397
const LM_CHIN            = 152
const LM_NOSE_BRIDGE     = 6
const LM_EYE_OUTER_L     = 33
const LM_EYE_OUTER_R     = 263
const LM_EYE_INNER_L     = 133
const LM_EYE_INNER_R     = 362
const LM_MOUTH_L         = 61
const LM_MOUTH_R         = 291
const LM_LIP_UPPER       = 13
const LM_LIP_LOWER       = 14
const LM_MID_CHEEK_L     = 187
const LM_MID_CHEEK_R     = 411
const LM_LOWER_CHEEK_L   = 136
const LM_LOWER_CHEEK_R   = 365

// Structural triangles — each is [a, b, c] landmark indices.
// Grouped by zone for optional per-zone coloring.
const MESH_FOREHEAD: [number, number, number][] = [
  [LM_FOREHEAD_TOP,  LM_FOREHEAD_L,   LM_BROW_CENTER],
  [LM_FOREHEAD_TOP,  LM_FOREHEAD_R,   LM_BROW_CENTER],
  [LM_FOREHEAD_TOP,  LM_FOREHEAD_L,   LM_TEMPLE_L],
  [LM_FOREHEAD_TOP,  LM_FOREHEAD_R,   LM_TEMPLE_R],
]

const MESH_CHEEKS: [number, number, number][] = [
  // Upper cheeks
  [LM_EYE_OUTER_L,   LM_CHEEKBONE_L,  LM_TEMPLE_L],
  [LM_EYE_OUTER_R,   LM_CHEEKBONE_R,  LM_TEMPLE_R],
  [LM_EYE_OUTER_L,   LM_CHEEKBONE_L,  NOSE_TIP],
  [LM_EYE_OUTER_R,   LM_CHEEKBONE_R,  NOSE_TIP],
  // Mid cheeks
  [LM_CHEEKBONE_L,   LM_MID_CHEEK_L,  NOSE_TIP],
  [LM_CHEEKBONE_R,   LM_MID_CHEEK_R,  NOSE_TIP],
  // Lower cheeks
  [LM_MID_CHEEK_L,   LM_MOUTH_L,      LM_LOWER_CHEEK_L],
  [LM_MID_CHEEK_R,   LM_MOUTH_R,      LM_LOWER_CHEEK_R],
  [LM_CHEEKBONE_L,   LM_MID_CHEEK_L,  LM_LOWER_CHEEK_L],
  [LM_CHEEKBONE_R,   LM_MID_CHEEK_R,  LM_LOWER_CHEEK_R],
]

const MESH_NOSE: [number, number, number][] = [
  [LM_BROW_CENTER,   LM_EYE_INNER_L,  LM_NOSE_BRIDGE],
  [LM_BROW_CENTER,   LM_EYE_INNER_R,  LM_NOSE_BRIDGE],
  [LM_NOSE_BRIDGE,   LM_EYE_INNER_L,  NOSE_TIP],
  [LM_NOSE_BRIDGE,   LM_EYE_INNER_R,  NOSE_TIP],
]

const MESH_CHIN: [number, number, number][] = [
  [LM_MOUTH_L,       LM_LIP_LOWER,    LM_LOWER_CHEEK_L],
  [LM_MOUTH_R,       LM_LIP_LOWER,    LM_LOWER_CHEEK_R],
  [LM_LOWER_CHEEK_L, LM_CHIN,         LM_LIP_LOWER],
  [LM_LOWER_CHEEK_R, LM_CHIN,         LM_LIP_LOWER],
  [LM_LOWER_CHEEK_L, LM_CHIN,         LM_JAW_L],
  [LM_LOWER_CHEEK_R, LM_CHIN,         LM_JAW_R],
]

const MESH_MOUTH: [number, number, number][] = [
  [LM_MOUTH_L,       LM_LIP_UPPER,    NOSE_TIP],
  [LM_MOUTH_R,       LM_LIP_UPPER,    NOSE_TIP],
  [LM_MOUTH_L,       LM_LIP_LOWER,    LM_LIP_UPPER],
  [LM_MOUTH_R,       LM_LIP_LOWER,    LM_LIP_UPPER],
]

// Eyebrow polyline indices
const LEFT_BROW  = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46]
const RIGHT_BROW = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276]

// Outer lip contour
const LIP_UPPER = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291]
const LIP_LOWER = [291, 375, 321, 405, 314, 17, 84, 181, 91, 146, 61]

// Nose ridge
const NOSE_RIDGE = [9, 168, 6, 197, 195, 5, 4, 1]

interface MeshZone {
  triangles: [number, number, number][]
  fillColor: string
  strokeColor: string
}

/**
 * Draw a triangulated wire-mask mesh over the face.
 * Creates a low-poly faceted look with semi-transparent fills
 * and visible edges, plus eyebrow arcs, lip contour, and nose ridge.
 */
export function drawFaceMesh(
  ctx: CanvasRenderingContext2D,
  landmarks: FaceLandmark[],
  w: number,
  h: number,
): void {
  if (!landmarks || landmarks.length < 400) return

  const lx = (lm: FaceLandmark) => (1 - lm.x) * w
  const ly = (lm: FaceLandmark) => lm.y * h

  // Zone definitions with per-zone colors
  const zones: MeshZone[] = [
    {
      triangles: MESH_FOREHEAD,
      fillColor: 'rgba(100, 180, 255, 0.07)',
      strokeColor: 'rgba(100, 180, 255, 0.35)',
    },
    {
      triangles: MESH_CHEEKS,
      fillColor: 'rgba(120, 220, 255, 0.06)',
      strokeColor: 'rgba(120, 220, 255, 0.30)',
    },
    {
      triangles: MESH_NOSE,
      fillColor: 'rgba(140, 230, 255, 0.08)',
      strokeColor: 'rgba(140, 230, 255, 0.35)',
    },
    {
      triangles: MESH_CHIN,
      fillColor: 'rgba(110, 200, 255, 0.05)',
      strokeColor: 'rgba(110, 200, 255, 0.25)',
    },
    {
      triangles: MESH_MOUTH,
      fillColor: 'rgba(130, 210, 255, 0.06)',
      strokeColor: 'rgba(130, 210, 255, 0.28)',
    },
  ]

  // Draw filled + stroked triangles
  for (const zone of zones) {
    for (const [a, b, c] of zone.triangles) {
      const la = landmarks[a], lb = landmarks[b], lc = landmarks[c]
      if (!la || !lb || !lc) continue

      ctx.beginPath()
      ctx.moveTo(lx(la), ly(la))
      ctx.lineTo(lx(lb), ly(lb))
      ctx.lineTo(lx(lc), ly(lc))
      ctx.closePath()

      ctx.fillStyle = zone.fillColor
      ctx.fill()

      ctx.strokeStyle = zone.strokeColor
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }

  // Draw vertex dots at structural points
  const structuralPoints = [
    LM_FOREHEAD_TOP, LM_FOREHEAD_L, LM_FOREHEAD_R, LM_BROW_CENTER,
    LM_TEMPLE_L, LM_TEMPLE_R, LM_CHEEKBONE_L, LM_CHEEKBONE_R,
    LM_JAW_L, LM_JAW_R, LM_CHIN, NOSE_TIP, LM_NOSE_BRIDGE,
    LM_EYE_OUTER_L, LM_EYE_OUTER_R, LM_EYE_INNER_L, LM_EYE_INNER_R,
    LM_MOUTH_L, LM_MOUTH_R, LM_LIP_UPPER, LM_LIP_LOWER,
    LM_MID_CHEEK_L, LM_MID_CHEEK_R, LM_LOWER_CHEEK_L, LM_LOWER_CHEEK_R,
  ]
  ctx.fillStyle = 'rgba(120, 220, 255, 0.5)'
  for (const idx of structuralPoints) {
    const lm = landmarks[idx]
    if (!lm) continue
    ctx.beginPath()
    ctx.arc(lx(lm), ly(lm), 1.5, 0, Math.PI * 2)
    ctx.fill()
  }

  // Eyebrows
  const drawPolyline = (indices: number[], color: string, lineWidth: number) => {
    ctx.beginPath()
    ctx.strokeStyle = color
    ctx.lineWidth = lineWidth
    const first = landmarks[indices[0]]
    if (!first) return
    ctx.moveTo(lx(first), ly(first))
    for (let i = 1; i < indices.length; i++) {
      const lm = landmarks[indices[i]]
      if (!lm) continue
      ctx.lineTo(lx(lm), ly(lm))
    }
    ctx.stroke()
  }

  drawPolyline(LEFT_BROW, 'rgba(120, 220, 255, 0.6)', 1.5)
  drawPolyline(RIGHT_BROW, 'rgba(120, 220, 255, 0.6)', 1.5)

  // Nose ridge
  drawPolyline(NOSE_RIDGE, 'rgba(140, 230, 255, 0.45)', 1.2)

  // Lip contour
  drawPolyline(LIP_UPPER, 'rgba(150, 200, 255, 0.45)', 1)
  drawPolyline(LIP_LOWER, 'rgba(150, 200, 255, 0.45)', 1)
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
