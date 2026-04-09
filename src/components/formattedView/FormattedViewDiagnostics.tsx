export interface UploadDiag {
  parsedCount: number
  fileStorageAvailable: boolean
  attempted: number
  opfsCount: number
  dexieCount: number
  nativeCount: number
  failedCount: number
  firstError: string | null
}

export interface ImageDiag {
  expected: number
  opfsCount: number
  dexieCount: number
  missingCount: number
}

interface FormattedViewDiagnosticsProps {
  enabled: boolean
  imageDiag: ImageDiag | null
  uploadDiag: UploadDiag | null
}

export function FormattedViewDiagnostics({
  enabled,
  imageDiag,
  uploadDiag,
}: FormattedViewDiagnosticsProps) {
  if (!enabled || !imageDiag) return null

  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        padding: '8px 12px',
        background: 'rgba(0,0,0,0.85)',
        color: '#9ef',
        font: '12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
        borderBottom: '1px solid rgba(150,200,255,0.3)',
        textAlign: 'center',
      }}
    >
      <div style={{ color: '#fff', fontWeight: 'bold' }}>
        read: {imageDiag.opfsCount + imageDiag.dexieCount}/{imageDiag.expected} loaded
      </div>
      <div>
        opfs: {imageDiag.opfsCount} · dexie: {imageDiag.dexieCount} · missing: {imageDiag.missingCount}
      </div>
      {uploadDiag && (
        <>
          <div style={{ marginTop: 4, color: '#fff', fontWeight: 'bold' }}>
            upload: parsed {uploadDiag.parsedCount}, attempted {uploadDiag.attempted}
          </div>
          <div>
            opfs: {uploadDiag.opfsCount} · dexie: {uploadDiag.dexieCount} · native: {uploadDiag.nativeCount} · failed: {uploadDiag.failedCount}
          </div>
          {!uploadDiag.fileStorageAvailable && (
            <div style={{ color: '#fc8' }}>file storage was unavailable at upload time</div>
          )}
          {uploadDiag.firstError && (
            <div style={{ color: '#fc8' }}>first err: {uploadDiag.firstError}</div>
          )}
        </>
      )}
      {!uploadDiag && (
        <div style={{ color: '#fc8', marginTop: 4 }}>
          no upload-diag in localStorage — pub uploaded before this build
        </div>
      )}
      {imageDiag.expected === 0 && (
        <div style={{ color: '#fc8' }}>parser produced no opfs: markers — book has no images</div>
      )}
    </div>
  )
}
