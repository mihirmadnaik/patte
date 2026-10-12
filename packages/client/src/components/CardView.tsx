import type { Face } from '@patte/core';
import { FAN_PIVOT, type Metrics, type Placement } from '../geometry.js';

const SUIT_GLYPH: Record<string, string> = { C: '♣', D: '♦', H: '♥', S: '♠' };

export interface CardViewProps {
  /** How big a card is on this screen. */
  m: Metrics;
  cardId: string;
  face: Face | null;
  /** Whether the whole table can read this card, not just us. */
  isPublic: boolean;
  /** Where it sits on the table. Not needed when laid out in flow. */
  placement?: Placement;
  heldByOther: boolean;
  selected: boolean;
  dragging: boolean;
  /** A peeked card is lifted and shown to us alone, for a moment. */
  peeking: boolean;
  /** Legal to play right now, in a game that has rules. */
  playable: boolean;
  /** In hand on your turn, but not legal to play. */
  blocked: boolean;
  /** The card most recently put down, so the table can see what was played. */
  lastPlay: boolean;
  interactive: boolean;
  /**
   * Laid out in flow rather than positioned on the table.
   *
   * The hand drawer is a scrolling strip, which needs real layout: a
   * transform-positioned card cannot be scrolled by the browser.
   */
  inline?: boolean;
  onPointerDown(event: React.PointerEvent, cardId: string): void;
  /**
   * Optional, and the only place a tap should be acted on where the card sits
   * inside something scrollable: a press has not yet decided whether it is a
   * tap or the start of a scroll.
   */
  onPointerUp?(event: React.PointerEvent, cardId: string): void;
  onDoubleClick(cardId: string): void;
}

export function CardView(props: CardViewProps): React.JSX.Element {
  const { face, isPublic, peeking } = props;
  const placement = props.placement ?? { x: 0, y: 0, rotate: 0, z: 0 };
  // Draw a face whenever we have one, and a back whenever we do not.
  //
  // That is the whole rule, and it is deliberately not a decision this
  // component gets to make: the server already decided what we are entitled
  // to see, and a card we may not see arrives with no face at all. So this
  // renderer *cannot* show a card it should not -- there is nothing to draw.
  // It also gives the right answer for the case that matters most: the cards
  // in your own hand lie face down on the table but read face up to you.
  const showFace = face !== null;
  const red = face?.suit === 'H' || face?.suit === 'D';

  const classes = ['card'];
  if (showFace) classes.push('card--face');
  else classes.push('card--back');
  // A face you can see that the table cannot is worth marking. Knowing at a
  // glance whether you are looking at your own hand or at something everyone
  // can read is the difference between playing a card and exposing one.
  if (showFace && !isPublic) classes.push('card--private');
  if (props.lastPlay) classes.push('is-last-play');
  if (props.playable) classes.push('is-playable');
  if (props.blocked) classes.push('is-blocked');
  if (props.selected) classes.push('is-selected');
  if (props.dragging) classes.push('is-dragging');
  if (props.heldByOther) classes.push('is-held');
  if (peeking) classes.push('is-peeking');
  if (red) classes.push('is-red');

  // A zone may ask for its cards small -- a face-down marker rather than a
  // card you read. Width and height are scaled rather than a CSS transform so
  // that the border radius, the shadow and the pointer target all shrink with
  // it, and the `em` sizing below carries the printing down with them.
  const scale = props.placement?.scale ?? 1;
  const cardW = props.m.cardW * scale;
  const cardH = props.m.cardH * scale;

  return (
    <div
      className={classes.join(' ')}
      data-card={props.cardId}
      style={{
        width: cardW,
        height: cardH,
        // Everything printed on the card is sized in `em`, so the rank, suit
        // and pip shrink with it. A fixed 13px index on a 54px card crowds the
        // corner it is supposed to sit in.
        fontSize: (cardW * 13) / 76,
        // Set here rather than in the stylesheet so that the one thing which
        // has to land on a turned card -- the play button -- can read the same
        // pivot and turn about it.
        transformOrigin: `${FAN_PIVOT.x * 100}% ${FAN_PIVOT.y * 100}%`,
        ...(props.inline
          ? { position: 'relative', flex: '0 0 auto' }
          : {
              transform: `translate3d(${placement.x}px, ${placement.y}px, 0) rotate(${placement.rotate}deg)`,
              zIndex: placement.z,
            }),
        pointerEvents: props.interactive && !props.dragging ? 'auto' : 'none',
      }}
      onPointerDown={(event) => props.onPointerDown(event, props.cardId)}
      onPointerUp={(event) => props.onPointerUp?.(event, props.cardId)}
      onDoubleClick={() => props.onDoubleClick(props.cardId)}
    >
      {showFace && face ? (
        <>
          <span className="card__corner card__corner--tl">
            {face.rank === 'JOKER' ? 'J★' : face.rank}
            <em>{face.suit ? SUIT_GLYPH[face.suit] : ''}</em>
          </span>
          <span className="card__pip">{face.suit ? SUIT_GLYPH[face.suit] : '★'}</span>
          <span className="card__corner card__corner--br">
            {face.rank === 'JOKER' ? 'J★' : face.rank}
            <em>{face.suit ? SUIT_GLYPH[face.suit] : ''}</em>
          </span>
        </>
      ) : (
        <span className="card__back" />
      )}
    </div>
  );
}
