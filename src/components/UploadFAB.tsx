import { useRef } from 'react';

interface UploadFABProps {
  onFileSelect: (file: File) => void;
  uploading: boolean;
  uploadPhase: string;
  uploadPercent: number;
}

const ACCEPTED = '.epub,.pdf,.txt,.html,.htm,.md,.fb2,.rtf,.docx,.cbz';

export default function UploadFAB({ onFileSelect, uploading, uploadPhase, uploadPercent }: UploadFABProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onFileSelect(file);
    // Reset so same file can be re-selected
    e.target.value = '';
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED}
        onChange={handleChange}
        style={{ display: 'none' }}
        aria-hidden="true"
      />
      <button
        className={`upload-fab${uploading ? ' upload-fab--uploading' : ''}`}
        onClick={() => !uploading && inputRef.current?.click()}
        disabled={uploading}
        aria-label={uploading ? `Uploading: ${uploadPhase} ${uploadPercent}%` : 'Upload a book'}
        title="Upload a book"
      >
        {uploading ? (
          <svg className="upload-fab__spinner" width="28" height="28" viewBox="0 0 28 28">
            <circle cx="14" cy="14" r="11" fill="none" stroke="var(--bg)" strokeWidth="2.5" opacity="0.3" />
            <circle
              cx="14" cy="14" r="11" fill="none" stroke="var(--bg)" strokeWidth="2.5"
              strokeDasharray={`${(uploadPercent / 100) * 69.1} 69.1`}
              strokeLinecap="round"
              transform="rotate(-90 14 14)"
            />
          </svg>
        ) : (
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="var(--bg)" strokeWidth="2.2" strokeLinecap="round">
            <line x1="14" y1="7" x2="14" y2="21" />
            <line x1="7" y1="14" x2="21" y2="14" />
          </svg>
        )}
      </button>
    </>
  );
}
