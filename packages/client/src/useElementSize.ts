import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface Size {
  width: number;
  height: number;
}

/**
 * The measured size of an element, or null until it has been measured.
 *
 * Measures directly with `getBoundingClientRect` on mount rather than waiting
 * for `ResizeObserver` to deliver its first observation. The observer is an
 * enhancement for later resizes, not the source of truth: some environments
 * never send that initial callback, and a layout that quietly falls back to a
 * hardcoded default is a layout that is wrong with nothing to show for it.
 *
 * Returning null rather than a guess is the other half of that. A caller that
 * cannot lay out yet should wait one frame, not draw the table in the wrong
 * place and correct itself.
 */
export function useElementSize<T extends HTMLElement>(
  /**
   * Anything that changes the surrounding layout and so the size of this
   * element -- a status bar that appears when a game starts, say. The
   * observer's callback cannot be relied upon to notice, so the caller says
   * when a fresh measurement is due.
   */
  deps: readonly unknown[] = [],
): [RefObject<T | null>, Size | null] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<Size | null>(null);
  const remeasure = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const measure = (): void => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return; // not laid out yet
      setSize((previous) =>
        previous && previous.width === rect.width && previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height },
      );
    };

    remeasure.current = measure;
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    // A tab that mounts in the background has a zero-sized viewport, and gets
    // its real one only when it is shown.
    document.addEventListener('visibilitychange', measure);

    // Keep trying while the element has no size at all. Fonts and scrollbars
    // settle a frame late, and a hidden tab may have no box for much longer
    // than that -- and since the observer's first callback cannot be relied
    // upon, waiting for it risks a table that stays blank for good.
    let frame = 0;
    let attempts = 0;
    const retry = (): void => {
      measure();
      const rect = element.getBoundingClientRect();
      if ((rect.width > 0 || rect.height > 0) || attempts++ > 240) return;
      frame = requestAnimationFrame(retry);
    };
    frame = requestAnimationFrame(retry);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      document.removeEventListener('visibilitychange', measure);
      cancelAnimationFrame(frame);
    };
  }, []);

  // Runs after the commit that added or removed the neighbouring element, so
  // the box being measured is already its final size.
  useLayoutEffect(() => {
    remeasure.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return [ref, size];
}
