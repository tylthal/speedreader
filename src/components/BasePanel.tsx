import React from 'react';
import { useModalAnimation } from '../hooks/useModalAnimation';

interface BasePanelProps {
  /** Called when the panel should close (after exit animation, if animated). */
  onClose: () => void;
  /** CSS class toggled on the inner container for enter/exit animation. */
  visibleClass: string;
  /** Class for the full-screen backdrop wrapper. */
  overlayClassName: string;
  /** Class for the inner animated container. */
  className: string;
  /** ARIA role for the dialog container. Defaults to "dialog". */
  role?: string;
  ariaLabel?: string;
  ariaModal?: boolean;
  /** Exit animation duration in ms. Forwarded to useModalAnimation. */
  animateOutMs?: number;
  /**
   * When true (default), backdrop click triggers the animated close path
   * (removes visibleClass then calls onClose after animateOutMs). When
   * false, backdrop click calls onClose directly.
   */
  animateBackdropClose?: boolean;
  /**
   * Panel contents. May be a ReactNode or a render-prop receiving
   * `handleClose` so interactive children (e.g. cancel / option buttons)
   * can trigger the animated close path.
   */
  children:
    | React.ReactNode
    | ((api: { handleClose: () => void }) => React.ReactNode);
}

/**
 * Shared primitive for mount-based modal panels that animate in on mount
 * and animate out on close. Owns the backdrop, Escape-to-close handler,
 * and the enter/exit animation scaffold via `useModalAnimation`.
 *
 * Callers retain control of their own CSS class names, so existing
 * styling (`action-sheet__overlay`, `bookmark-dialog--visible`, etc.)
 * is preserved unchanged.
 */
export default function BasePanel({
  onClose,
  visibleClass,
  overlayClassName,
  className,
  role = 'dialog',
  ariaLabel,
  ariaModal,
  animateOutMs,
  animateBackdropClose = true,
  children,
}: BasePanelProps) {
  const { ref, handleClose } = useModalAnimation<HTMLDivElement>(
    onClose,
    visibleClass,
    animateOutMs,
  );

  const onBackdropClick = animateBackdropClose ? handleClose : onClose;

  return (
    <div className={overlayClassName} onClick={onBackdropClick}>
      <div
        ref={ref}
        className={className}
        onClick={(e) => e.stopPropagation()}
        role={role}
        aria-label={ariaLabel}
        aria-modal={ariaModal}
      >
        {typeof children === 'function' ? children({ handleClose }) : children}
      </div>
    </div>
  );
}
