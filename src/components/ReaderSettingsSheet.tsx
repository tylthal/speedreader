import BasePanel from './BasePanel';
import { useSwipeDismiss } from '../hooks/useSwipeDismiss';
import {
  type ColumnWidthKey,
  type FontScaleKey,
  type LineHeightKey,
  type ReaderTypography,
} from '../hooks/useReaderTypography';

interface ReaderSettingsSheetProps {
  typography: ReaderTypography;
  onFontScale: (key: FontScaleKey) => void;
  onLineHeight: (key: LineHeightKey) => void;
  onColumnWidth: (key: ColumnWidthKey) => void;
  onClose: () => void;
}

const SIZE_OPTIONS: { key: FontScaleKey; label: string; preview: string }[] = [
  { key: 'small', label: 'Small', preview: 'Aa' },
  { key: 'medium', label: 'Medium', preview: 'Aa' },
  { key: 'large', label: 'Large', preview: 'Aa' },
];

const LINE_HEIGHT_OPTIONS: { key: LineHeightKey; label: string }[] = [
  { key: 'tight', label: 'Tight' },
  { key: 'normal', label: 'Normal' },
  { key: 'loose', label: 'Loose' },
];

const COLUMN_OPTIONS: { key: ColumnWidthKey; label: string }[] = [
  { key: 'narrow', label: 'Narrow' },
  { key: 'default', label: 'Default' },
  { key: 'wide', label: 'Wide' },
];

export default function ReaderSettingsSheet({
  typography,
  onFontScale,
  onLineHeight,
  onColumnWidth,
  onClose,
}: ReaderSettingsSheetProps) {
  return (
    <BasePanel
      onClose={onClose}
      visibleClass="action-sheet--visible"
      overlayClassName="action-sheet__overlay"
      className="action-sheet reader-settings"
      ariaLabel="Reader appearance"
    >
      {({ handleClose, panelRef }) => (
        <Body
          typography={typography}
          onFontScale={onFontScale}
          onLineHeight={onLineHeight}
          onColumnWidth={onColumnWidth}
          handleClose={handleClose}
          panelRef={panelRef}
        />
      )}
    </BasePanel>
  );
}

interface BodyProps {
  typography: ReaderTypography;
  onFontScale: (key: FontScaleKey) => void;
  onLineHeight: (key: LineHeightKey) => void;
  onColumnWidth: (key: ColumnWidthKey) => void;
  handleClose: () => void;
  panelRef: React.RefObject<HTMLDivElement | null>;
}

function Body({ typography, onFontScale, onLineHeight, onColumnWidth, handleClose, panelRef }: BodyProps) {
  const { bind } = useSwipeDismiss<HTMLDivElement, HTMLDivElement>({
    panelRef,
    axis: 'y',
    onDismiss: handleClose,
  });
  return (
    <>
      <div className="action-sheet__drag-zone" {...bind()}>
        <div className="action-sheet__handle" />
      </div>

      <div className="action-sheet__header">
        <h3 className="action-sheet__title">Reader appearance</h3>
        <p className="action-sheet__subtitle">Applies to every book.</p>
      </div>

      <div className="reader-settings__group" role="radiogroup" aria-label="Text size">
        <span className="reader-settings__label">Text size</span>
        <div className="reader-settings__choices">
          {SIZE_OPTIONS.map((opt, i) => (
            <button
              key={opt.key}
              type="button"
              role="radio"
              aria-checked={typography.fontScale === opt.key}
              className={`reader-settings__choice reader-settings__choice--size reader-settings__choice--size-${i}${typography.fontScale === opt.key ? ' reader-settings__choice--active' : ''}`}
              onClick={() => onFontScale(opt.key)}
            >
              <span className="reader-settings__preview" aria-hidden="true">{opt.preview}</span>
              <span className="reader-settings__choice-label">{opt.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="reader-settings__group" role="radiogroup" aria-label="Line spacing">
        <span className="reader-settings__label">Line spacing</span>
        <div className="reader-settings__choices">
          {LINE_HEIGHT_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              role="radio"
              aria-checked={typography.lineHeight === opt.key}
              className={`reader-settings__choice${typography.lineHeight === opt.key ? ' reader-settings__choice--active' : ''}`}
              onClick={() => onLineHeight(opt.key)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="reader-settings__group" role="radiogroup" aria-label="Column width">
        <span className="reader-settings__label">Column width</span>
        <div className="reader-settings__choices">
          {COLUMN_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              role="radio"
              aria-checked={typography.columnWidth === opt.key}
              className={`reader-settings__choice${typography.columnWidth === opt.key ? ' reader-settings__choice--active' : ''}`}
              onClick={() => onColumnWidth(opt.key)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <button className="action-sheet__cancel" type="button" onClick={handleClose}>
        Done
      </button>
    </>
  );
}
