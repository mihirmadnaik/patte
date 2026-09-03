import { useEffect, useState } from 'react';
import { PHONE_WIDTH } from './geometry.js';

/**
 * Whether the window is phone-sized.
 *
 * Uses `matchMedia` rather than measuring: it fires reliably, including in
 * environments where `ResizeObserver` does not, and it is the same threshold
 * the layout solver uses so the chrome and the cards agree about what a phone
 * is.
 */
export function useCompact(): boolean {
  const [compact, setCompact] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < PHONE_WIDTH,
  );

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${PHONE_WIDTH - 1}px)`);
    const update = (): void => setCompact(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return compact;
}

/**
 * Whether this is a touch device with no real pointer.
 *
 * Used to stop broadcasting cursor presence nobody can produce, and to prefer
 * tapping over dragging.
 */
export function isTouchOnly(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches;
}
