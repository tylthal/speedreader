import { useEffect, useRef, useState } from 'react';
import BasePanel from './BasePanel';
import { useSwipeDismiss } from '../hooks/useSwipeDismiss';

const PRESETS = [200, 300, 450, 600];
const MIN_WPM = 50;
const MAX_WPM = 1200;
const STEP = 25;

interface WpmPresetPickerProps {
  wpm: number;
  onSetWpm: (wpm: number) => void;
  onClose: () => void;
}

function clamp(n: number): number {
  return Math.max(MIN_WPM, Math.min(MAX_WPM, Math.round(n / STEP) * STEP));
}

export default function WpmPresetPicker({ wpm, onSetWpm, onClose }: WpmPresetPickerProps) {
  const [draft, setDraft] = useState(wpm);
  const [inputValue, setInputValue] = useState(String(wpm));

  useEffect(() => {
    setInputValue(String(draft));
  }, [draft]);

  // Keep focus from jumping the sheet: use visualViewport to anchor above keyboard.
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : undefined;
    if (!vv) return;
    const update = () => {
      const keyboard = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--keyboard-height', `${Math.round(keyboard)}px`);
    };
    update();
    vv.addEventListener('resize', update);
    return () => {
      vv.removeEventListener('resize', update);
      document.documentElement.style.removeProperty('--keyboard-height');
    };
  }, []);

  return (
    <BasePanel
      onClose={onClose}
      visibleClass="action-sheet--visible"
      overlayClassName="action-sheet__overlay"
      className="action-sheet wpm-picker"
      ariaLabel="Reading speed"
    >
      {({ handleClose, panelRef }) => (
        <WpmPresetBody
          draft={draft}
          setDraft={setDraft}
          inputValue={inputValue}
          setInputValue={setInputValue}
          onSetWpm={onSetWpm}
          handleClose={handleClose}
          panelRef={panelRef}
        />
      )}
    </BasePanel>
  );
}

interface BodyProps {
  draft: number;
  setDraft: (wpm: number) => void;
  inputValue: string;
  setInputValue: (v: string) => void;
  onSetWpm: (wpm: number) => void;
  handleClose: () => void;
  panelRef: React.RefObject<HTMLDivElement | null>;
}

function WpmPresetBody({
  draft,
  setDraft,
  inputValue,
  setInputValue,
  onSetWpm,
  handleClose,
  panelRef,
}: BodyProps) {
  const { bind } = useSwipeDismiss<HTMLDivElement, HTMLDivElement>({
    panelRef,
    axis: 'y',
    onDismiss: handleClose,
  });
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (next: number) => {
    const clamped = clamp(next);
    setDraft(clamped);
    onSetWpm(clamped);
  };

  const pickPreset = (p: number) => {
    commit(p);
    handleClose();
  };

  return (
    <>
      <div className="action-sheet__drag-zone" {...bind()}>
        <div className="action-sheet__handle" />
      </div>

      <div className="action-sheet__header">
        <h3 className="action-sheet__title">Reading speed</h3>
        <p className="action-sheet__subtitle">Tap a preset, drag the slider, or type a value.</p>
      </div>

      <ul className="wpm-picker__presets" aria-label="Speed presets">
        {PRESETS.map((p) => (
          <li key={p}>
            <button
              type="button"
              className={`wpm-picker__preset${draft === p ? ' wpm-picker__preset--active' : ''}`}
              onClick={() => pickPreset(p)}
            >
              {p}
              <span className="wpm-picker__preset-unit">WPM</span>
            </button>
          </li>
        ))}
      </ul>

      <label className="wpm-picker__slider-row">
        <span className="wpm-picker__slider-label">Fine tune</span>
        <input
          type="range"
          min={MIN_WPM}
          max={MAX_WPM}
          step={STEP}
          value={draft}
          onChange={(e) => commit(Number(e.target.value))}
          className="wpm-picker__slider"
          aria-label={`Reading speed: ${draft} words per minute`}
        />
        <span className="wpm-picker__slider-value" aria-hidden="true">{draft}</span>
      </label>

      <label className="wpm-picker__numeric">
        <span>Exact value</span>
        <div className="wpm-picker__numeric-input-wrap">
          <input
            ref={inputRef}
            type="number"
            inputMode="numeric"
            min={MIN_WPM}
            max={MAX_WPM}
            step={STEP}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onBlur={() => {
              const parsed = Number(inputValue);
              if (Number.isFinite(parsed)) commit(parsed);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const parsed = Number(inputValue);
                if (Number.isFinite(parsed)) commit(parsed);
                handleClose();
              }
            }}
            className="wpm-picker__numeric-input"
          />
          <span className="wpm-picker__numeric-unit">WPM</span>
        </div>
      </label>

      <button className="action-sheet__cancel" type="button" onClick={handleClose}>
        Done
      </button>
    </>
  );
}
