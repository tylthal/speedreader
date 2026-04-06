import React from 'react';

interface EmptyStateProps {
  icon: 'library' | 'archive' | 'search';
  title: string;
  description: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

const icons: Record<string, React.ReactNode> = {
  library: (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" opacity="0.3">
      <rect x="8" y="12" width="12" height="44" rx="2" stroke="var(--text-muted)" strokeWidth="2" />
      <rect x="24" y="8" width="12" height="48" rx="2" stroke="var(--text-muted)" strokeWidth="2" />
      <rect x="40" y="14" width="12" height="42" rx="2" stroke="var(--text-muted)" strokeWidth="2" transform="rotate(6 46 35)" />
      <line x1="12" y1="20" x2="16" y2="20" stroke="var(--text-muted)" strokeWidth="1.5" />
      <line x1="28" y1="16" x2="32" y2="16" stroke="var(--text-muted)" strokeWidth="1.5" />
    </svg>
  ),
  archive: (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" opacity="0.3">
      <rect x="8" y="12" width="48" height="12" rx="3" stroke="var(--text-muted)" strokeWidth="2" />
      <path d="M12 24v24a4 4 0 0 0 4 4h32a4 4 0 0 0 4-4V24" stroke="var(--text-muted)" strokeWidth="2" />
      <path d="M26 34h12" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  search: (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" opacity="0.3">
      <circle cx="28" cy="28" r="14" stroke="var(--text-muted)" strokeWidth="2" />
      <line x1="38" y1="38" x2="52" y2="52" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
};

export default function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">{icons[icon]}</div>
      <h2 className="empty-state__title">{title}</h2>
      <p className="empty-state__description">{description}</p>
      {action && (
        <button className="empty-state__action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
