import React from 'react';
import { useModalAnimation } from '../hooks/useModalAnimation';

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
  const { ref: sheetRef, handleClose } = useModalAnimation(onClose, 'action-sheet--visible');

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
