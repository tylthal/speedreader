import React from 'react';
import BasePanel from './BasePanel';

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
  return (
    <BasePanel
      onClose={onClose}
      visibleClass="action-sheet--visible"
      overlayClassName="action-sheet__overlay"
      className="action-sheet"
      ariaLabel={title}
    >
      {({ handleClose }) => (
        <>
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
        </>
      )}
    </BasePanel>
  );
}
