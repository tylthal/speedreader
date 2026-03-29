export function useHaptics() {
  const vibrate = (pattern?: number | number[]) => {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(pattern ?? 10);
    }
  };

  return {
    tap: () => vibrate(10),       // light tap for play/pause
    tick: () => vibrate(5),       // subtle tick for WPM adjustment
    success: () => vibrate([10, 50, 10]),  // double tap for chapter change
  };
}
