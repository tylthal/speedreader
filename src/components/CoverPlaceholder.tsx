const PALETTE = [
  { bg: '#3B82F6', fg: '#DBEAFE' }, // blue
  { bg: '#10B981', fg: '#D1FAE5' }, // green
  { bg: '#F59E0B', fg: '#FEF3C7' }, // amber
  { bg: '#EF4444', fg: '#FEE2E2' }, // red
  { bg: '#8B5CF6', fg: '#EDE9FE' }, // violet
  { bg: '#EC4899', fg: '#FCE7F3' }, // pink
];

const SKIP_WORDS = new Set(['the', 'a', 'an']);

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function deriveInitials(title: string | undefined | null): string {
  if (!title) return '?';
  const words = title
    .trim()
    .split(/\s+/)
    .filter((w) => !SKIP_WORDS.has(w.toLowerCase()));
  const letters = (words.length > 0 ? words : [title])
    .slice(0, 2)
    .map((w) => w.charAt(0))
    .join('');
  const cleaned = letters.replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();
  return cleaned || '?';
}

interface CoverPlaceholderProps {
  title?: string | null;
  format?: string;
  featured?: boolean;
}

export default function CoverPlaceholder({ title, format, featured }: CoverPlaceholderProps) {
  const initials = deriveInitials(title ?? '');
  const label = initials !== '?' ? initials : (format || '?').toUpperCase().slice(0, 2);
  const seed = (title && title.length > 0) ? title : (format || 'book');
  const palette = PALETTE[hashString(seed) % PALETTE.length];
  const size = featured ? 72 : 56;
  const height = featured ? 108 : 84;

  return (
    <div
      className={`book-card__cover book-card__placeholder${featured ? ' book-card__placeholder--featured' : ''}`}
      style={{
        width: size,
        height,
        background: palette.bg,
        color: palette.fg,
      }}
      aria-hidden="true"
    >
      <span className="book-card__placeholder-initials">{label}</span>
    </div>
  );
}
