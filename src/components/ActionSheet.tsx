import React, { useEffect, useRef } from 'react';

export interface ActionSheetOption {
  label: string;
  icon?: React.ReactNode;
  variant?: 'default' | 'danger';
  onSelect: () => void;
}

interface ActionSheetProps {
  title: string;
  subtitle?: string;
  options: ActionSheetOption[];
  onClose: () => void;
}

export default function ActionSheet({ title, subtitle, options, onClose }: ActionSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Animate in
  useEffect(() => {
    requestAnimationFrame(() => {
      sheetRef.current?.classList.add('action-sheet--visible');
    });
  }, []);

  const handleClose = () => {
    sheetRef.current?.classList.remove('action-sheet--visible');
    setTimeout(onClose, 200);
  };

  return (
    <div className="action-sheet__overlay" onClick={handleClose}>
      <div
        ref={sheetRef}
        className="action-sheet"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <div className="action-sheet__handle" />

        <div className="action-sheet__header">
          <h3 className="action-sheet__title">{title}</h3>
          {subtitle && <p className="action-sheet__subtitle">{subtitle}</p>}
        </div>

        <div className="action-sheet__options">
          {options.map((opt, i) => (
            <button
              key={i}
              className={`action-sheet__option${opt.variant === 'danger' ? ' action-sheet__option--danger' : ''}`}
              onClick={() => {
                opt.onSelect();
                handleClose();
              }}
            >
              {opt.icon && <span className="action-sheet__option-icon">{opt.icon}</span>}
              <span>{opt.label}</span>
            </button>
          ))}
        </div>

        <button className="action-sheet__cancel" onClick={handleClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
