import { useId, useState, type ReactNode } from 'react';

interface AccordionProps {
  title: string;
  /** If true, section is open on mount. */
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * Lightweight disclosure section used to group Settings into collapsible
 * areas so the page isn't a single long thumb-scroll. The first section
 * is typically open on mount; others collapse by default.
 *
 * Uses `hidden` on the panel (rather than display:none in CSS) so the
 * content is properly removed from tab order while collapsed.
 */
export default function Accordion({ title, defaultOpen = false, children }: AccordionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const buttonId = useId();

  return (
    <section className={`accordion${open ? ' accordion--open' : ''}`}>
      <button
        type="button"
        id={buttonId}
        className="accordion__trigger"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="accordion__title">{title}</span>
        <svg
          className="accordion__chevron"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="4,6 8,10 12,6" />
        </svg>
      </button>
      <div
        id={panelId}
        role="region"
        aria-labelledby={buttonId}
        className="accordion__panel"
        hidden={!open}
      >
        {children}
      </div>
    </section>
  );
}
