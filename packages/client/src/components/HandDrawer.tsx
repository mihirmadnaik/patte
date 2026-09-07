/**
 * The hand, opened out.
 *
 * A fanned hand is fine to look at and hopeless to tap once it is crowded: a
 * Sevens hand of twenty-seven cards leaves under ten pixels of each one
 * showing. This slides the same cards into a strip you can scroll, at a pitch
 * you can actually hit.
 *
 * Where a card has exactly one place it can go, the play finishes here too: a
 * check appears on the card you just tapped and sends it. Bouncing back to the
 * fan to press a button you could have pressed here was a step for its own
 * sake. Where the destination is a real choice it still hands over to the
 * table, because that choice cannot be made from inside a strip of cards.
 */

import { canSeeFace, type GameState, type PlayerId } from '@patte/core';
import { useLayoutEffect, useRef } from 'react';
import type { Metrics } from '../geometry.js';
import { CardView } from './CardView.js';

/** How far down you have to drag before it counts as dismissing the sheet. */
const DISMISS_DISTANCE = 40;
/**
 * How far a press may wander and still count as a tap.
 *
 * Anything beyond this is a scroll, and belongs to the browser.
 */
const TAP_SLOP = 8;

export function HandDrawer({
  state,
  you,
  m,
  hand,
  openedFrom,
  playable,
  refereed,
  selected,
  confirmSize,
  canPlay,
  onPlay,
  onPick,
  onClose,
}: {
  state: GameState;
  you: PlayerId;
  m: Metrics;
  /** The hand in reading order, which is the table's to decide, not ours. */
  hand: readonly string[];
  /** The card the player had their thumb on when this opened, if any. */
  openedFrom: string | null;
  playable: Set<string>;
  refereed: boolean;
  /** The card chosen so far, which is where the play button goes. */
  selected: string | null;
  confirmSize: number;
  /** Whether this card has exactly one destination, so one tap can send it. */
  canPlay(cardId: string): boolean;
  onPlay(cardId: string): void;
  onPick(cardId: string): void;
  onClose(): void;
}): React.JSX.Element {
  const press = useRef<{ x: number; y: number } | null>(null);
  const strip = useRef<HTMLDivElement>(null);

  /*
   * Open where the player was looking.
   *
   * Twenty-six cards at full width is several screens of strip, and opening it
   * at the beginning every time means going to find the card you had your
   * thumb on a moment ago. Scrolled directly rather than with
   * `scrollIntoView`, which also scrolls whatever else it can find on the way
   * up -- and before paint, so the strip is never seen in the wrong place.
   */
  useLayoutEffect(() => {
    const box = strip.current;
    if (!box || !openedFrom) return;
    const card = box.querySelector<HTMLElement>(`[data-card="${openedFrom}"]`);
    if (!card) return;

    // Measured from the rectangles rather than from `offsetLeft`, which is
    // relative to the nearest positioned ancestor -- and each card sits in a
    // wrapper that is positioned, to hold the play button. `offsetLeft` was
    // therefore 0 for every card, and the strip never moved.
    const boxAt = box.getBoundingClientRect();
    const cardAt = card.getBoundingClientRect();
    const centreOfCard = box.scrollLeft + (cardAt.left - boxAt.left) + cardAt.width / 2;
    const centred = centreOfCard - box.clientWidth / 2;
    box.scrollLeft = Math.max(0, Math.min(centred, box.scrollWidth - box.clientWidth));
  }, [openedFrom]);

  return (
    <>
      {/* Anywhere outside the sheet dismisses it. */}
      <div className="drawer__scrim" onPointerDown={onClose} />

      <div
        className="drawer"
        onPointerDown={(event) => {
          press.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerUp={(event) => {
          const from = press.current;
          press.current = null;
          if (!from) return;

          // A downward drag puts the sheet away, the way a bottom sheet is
          // expected to behave -- but only a properly downward one. A diagonal
          // gesture is somebody scrolling the strip, and dismissing on it
          // would make the sheet impossible to scroll near its edges.
          const dy = event.clientY - from.y;
          const dx = Math.abs(event.clientX - from.x);
          if (dy > DISMISS_DISTANCE && dy > dx) onClose();
        }}
      >
        <button className="drawer__handle" onClick={onClose} aria-label="close your hand">
          <span />
        </button>

        {/* The play button floats clear above its card, so the strip carries
            headroom for it -- it scrolls horizontally, which means it clips
            vertically and a button drawn outside it would be cut in half. */}
        <div className="drawer__strip" ref={strip} style={{ paddingTop: confirmSize + 10 }}>
          {hand.map((cardId) => {
            const card = state.cards[cardId];
            if (!card) return null;
            return (
              <div className="drawer__slot" key={cardId}>
                <CardView
                  m={m}
                  inline
                  cardId={cardId}
                  face={card.face}
                  isPublic={canSeeFace(state, card, null)}
                  peeking={false}
                  lastPlay={false}
                  playable={refereed && playable.has(cardId)}
                  blocked={refereed && !playable.has(cardId)}
                  heldByOther={false}
                  selected={selected === cardId}
                  dragging={false}
                  interactive
                  // Nothing is decided on the press, and nothing is prevented:
                  // the strip is the one thing in the app that scrolls, every
                  // pixel of it is covered in cards, and a drag that starts on a
                  // card has to be able to become a scroll.
                  onPointerDown={() => undefined}
                  onPointerUp={(event: React.PointerEvent) => {
                    const from = press.current;
                    if (!from) return;
                    const moved = Math.hypot(event.clientX - from.x, event.clientY - from.y);
                    if (moved <= TAP_SLOP) onPick(cardId);
                  }}
                  onDoubleClick={() => undefined}
                />
                {selected === cardId && canPlay(cardId) && (
                  <button
                    className="playcheck playcheck--inline"
                    style={{ width: confirmSize, height: confirmSize }}
                    aria-label="play this card"
                    title="Play this card"
                    onClick={() => onPlay(cardId)}
                  >
                    <span className="playcheck__tick" />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <p className="drawer__hint">
          {selected && canPlay(selected)
            ? 'tap the check to play it'
            : `${hand.length} cards — tap one, or swipe down to close`}
        </p>
      </div>
    </>
  );
}
