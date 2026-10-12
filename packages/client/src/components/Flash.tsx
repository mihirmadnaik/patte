/**
 * One line, large, in the middle of the table, for a moment.
 *
 * Trump being named is not a notification — it is the fact the rest of the
 * hand is played against, and the player who did not choose it has to be told
 * plainly. A note in the corner is the wrong weight for that, and easy to
 * miss at exactly the moment it matters.
 *
 * Sometimes the fact *is* a card. लॅडीस plays most of a hand against a trump
 * nobody has seen, kept as a half-size token at the edge of the table because
 * face down there is nothing on it to read — and when it is finally turned
 * over, the card itself is the announcement. So it is held up full size, and
 * the words follow a beat later rather than arriving instead of it.
 */

import { CardView } from './CardView.js';
import { DEFAULT_METRICS } from '../geometry.js';
import { useStore } from '../store.js';

export function Flash(): React.JSX.Element | null {
  const text = useStore((s) => s.flash);
  const cardIds = useStore((s) => s.flashCards);
  const view = useStore((s) => s.view);
  if (!text) return null;

  // Only cards we are actually entitled to see. An announcement that named a
  // card we have no face for would draw a card back, which says nothing.
  const cards = cardIds
    .map((cardId) => view?.cards[cardId])
    .filter((card): card is NonNullable<typeof card> => card?.face != null);

  // Announces itself to a screen reader, and to nothing else: it is inert to
  // the pointer, so it cannot swallow a tap meant for the table underneath.
  return (
    <div className="flash" role="status" aria-live="polite">
      {cards.length > 0 && (
        <div className="flash__cards">
          {cards.map((card) => (
            <CardView
              key={card.id}
              m={DEFAULT_METRICS}
              cardId={card.id}
              face={card.face}
              isPublic
              heldByOther={false}
              selected={false}
              dragging={false}
              peeking={false}
              playable={false}
              blocked={false}
              lastPlay={false}
              interactive={false}
              inline
              onPointerDown={() => undefined}
              onDoubleClick={() => undefined}
            />
          ))}
        </div>
      )}
      <span className={`flash__line${cards.length > 0 ? ' flash__line--after' : ''}`}>{text}</span>
    </div>
  );
}
