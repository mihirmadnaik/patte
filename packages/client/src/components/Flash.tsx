/**
 * One line, large, in the middle of the table, for a moment.
 *
 * Trump being named is not a notification — it is the fact the rest of the
 * hand is played against, and the player who did not choose it has to be told
 * plainly. A note in the corner is the wrong weight for that, and easy to
 * miss at exactly the moment it matters.
 */

import { useStore } from '../store.js';

export function Flash(): React.JSX.Element | null {
  const text = useStore((s) => s.flash);
  if (!text) return null;

  // Announces itself to a screen reader, and to nothing else: it is inert to
  // the pointer, so it cannot swallow a tap meant for the table underneath.
  return (
    <div className="flash" role="status" aria-live="polite">
      <span className="flash__line">{text}</span>
    </div>
  );
}
