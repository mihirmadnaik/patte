/** Where things sit. Pure maths, no React. */

import { rankValue, type GameState, type PlayerId, type Zone } from '@patte/core';

/** The card size a roomy screen gets, and the shape every card keeps. */
export const DESKTOP_CARD_W = 76;
const CARD_RATIO = 106 / 76;
/** Below this a card stops being worth looking at, let alone tapping. */
const MIN_CARD_W = 46;
/** Under this width the table is a phone and the chrome compacts. */
export const PHONE_WIDTH = 480;
/** Breathing room at the left and right edges of the table. */
const SIDE_MARGIN = 12;
/**
 * How much of each card in a suit row must stay visible.
 *
 * On a roomy screen rows may tuck under one another a little; there is space,
 * the cards are large, and the computed spacing usually clears the floor
 * anyway. On a phone they may not: cards are already small, and two of them
 * stacked at the same rank read as a jumbled pile rather than two rows. So a
 * phone demands full separation and the solver pays for it by shrinking the
 * card, which is the right trade -- a smaller card you can read beats a larger
 * one behind another card.
 *
 * Shared by the fit model and the placement deliberately: when they were two
 * separate guesses they disagreed, the solver believed four rows cost two
 * cards of height, and the rows ended up overlapping by 56%.
 */
export const ROW_EXPOSURE_ROOMY = 0.62;
export const ROW_EXPOSURE_PHONE = 1;
/** How wide the trick drop area is, in cards. */
export const TRICK_WIDTH = 2.7;
/**
 * How large a card is allowed to be, once it is known what will fit.
 *
 * Not every table wants the biggest card that fits. A Sevens layout is read as
 * four rows -- what you are looking for is where a suit has got to, not the
 * detail of any one card -- and at full size the rows sit shoulder to shoulder
 * with nothing between them and the hand. Giving that family smaller cards
 * spends the difference on the gaps, which is what makes the layout legible.
 *
 * A 7-8 table is the opposite: five stacks across is already the tightest
 * thing here, and every card on it is one you might have to play.
 */
const CARD_SCALE: Record<LayoutFamily, number> = { stacks: 1, rows: 0.8, free: 1 };
/**
 * The gap between the last suit row and your own hand.
 *
 * Without it the rows are laid out to end exactly where the hand begins, and
 * they read as one continuous block -- the spade row looks like part of what
 * you are holding. Counted by the fit model as well as by the placement, or
 * the two disagree and the gap is taken out of somebody else's space.
 */
export function rowHandGap(m: Metrics): number {
  return Math.round(m.cardH * 0.18);
}

/**
 * Everything the layout measures itself in.
 *
 * These used to be module constants, which worked until the table had to fit a
 * phone: a 7-8 stack row needs 416px and a base iPhone offers 393. Rather than
 * a second hand-tuned layout, the card size is *solved for* -- the largest that
 * fits both axes -- and every other dimension is derived from it, so the table
 * shrinks as one piece.
 */
export interface Metrics {
  cardW: number;
  cardH: number;
  /** How far a buried card is slid out from under its cover. */
  peek: number;
  /** How far the ends of a fanned hand may droop below its middle. */
  fanLift: number;
  /** Room for a name plate, and the gap between it and the cards below. */
  nameBand: number;
  nameGap: number;
  /** Height kept clear beneath the table for the status pill. */
  statusBand: number;
  /** Phone-sized: drives compaction and touch affordances. */
  compact: boolean;
  /** The fraction of each suit row that must stay clear of the next. */
  rowExposure: number;
}

/** Which shape of table is being laid out; each has its own tightest fit. */
export type LayoutFamily = 'stacks' | 'rows' | 'free';

function derive(cardW: number, compact: boolean): Metrics {
  const scale = cardW / DESKTOP_CARD_W;
  return {
    cardW,
    cardH: Math.round(cardW * CARD_RATIO),
    peek: Math.round(14 * scale),
    fanLift: Math.round(26 * scale),
    // Chrome carries text, so it shrinks more slowly than the cards and stops
    // shrinking before the text becomes unreadable.
    nameBand: Math.max(34, Math.round(44 * scale)),
    nameGap: Math.max(6, Math.round(8 * scale)),
    statusBand: 68,
    compact,
    rowExposure: compact ? ROW_EXPOSURE_PHONE : ROW_EXPOSURE_ROOMY,
  };
}

/**
 * The top edge of the first suit row, below the opponents along the top.
 *
 * Exported so the fit model and the placement read the same expression. Three
 * separate bugs in this file came from a model that restated what the layout
 * does instead of deriving it, and drifted.
 *
 * It used to reserve a card's height here for the opponents' fanned backs.
 * Those are gone -- a hand you cannot see says nothing a count does not -- so
 * the rows start directly under the name plates and the whole layout gets a
 * card's height back, which the solver spends on bigger cards.
 */
export function rowsTop(m: Metrics): number {
  return m.nameBand + m.nameGap + 12;
}

/** The top edge of your own hand's cards, which nothing above may reach. */
export function handTop(m: Metrics, usableHeight: number): number {
  return usableHeight - m.cardH * 1.45;
}

/** The width a layout needs at a given card size. */
function widthNeeded(m: Metrics, family: LayoutFamily): number {
  switch (family) {
    // Five stacks side by side at a 1.12 pitch. This is the binding
    // constraint on a phone, and the reason cards have to scale at all.
    case 'stacks':
      return 4 * m.cardW * 1.12 + m.cardW;
    // A row of thirteen ranks overlaps, so only one whole card plus the
    // overlapped remainder has to fit.
    case 'rows':
      return m.cardW + 12 * m.cardW * 0.26;
    case 'free':
      return m.cardW * 3;
  }
}

/** The height a layout needs at a given card size, chrome included. */
function heightNeeded(m: Metrics, family: LayoutFamily): number {
  const MIN_GAP = 6;
  switch (family) {
    case 'stacks': {
      const bands =
        m.nameBand + m.nameGap + m.cardH + m.peek + // opponent
        m.cardH + // trick
        m.cardH + m.peek + // your stacks
        m.cardH + m.fanLift; // your hand
      return bands + 5 * MIN_GAP + m.statusBand;
    }
    case 'rows': {
      // Everything above the hand, plus the hand itself, plus the status band.
      // Written with the same helpers the placement uses so the two cannot
      // disagree about what a row costs.
      const rows = m.cardH + 3 * m.rowExposure * m.cardH;
      return rowsTop(m) + rows + rowHandGap(m) + m.cardH * 1.45 + m.statusBand;
    }
    case 'free':
      return m.cardH * 3 + m.fanLift;
  }
}

/**
 * The largest card that fits, for this table, at this size.
 *
 * Searched rather than solved algebraically: the derived dimensions have
 * floors on them, so the relationship is not quite linear, and stepping down a
 * pixel at a time is both obviously correct and cheap enough at thirty
 * iterations.
 */
export function metricsFor(width: number, height: number, family: LayoutFamily): Metrics {
  const compact = width < PHONE_WIDTH;
  const usableWidth = width - 2 * SIDE_MARGIN;

  for (let cardW = DESKTOP_CARD_W; cardW > MIN_CARD_W; cardW--) {
    const m = derive(cardW, compact);
    if (widthNeeded(m, family) <= usableWidth && heightNeeded(m, family) <= height) {
      // Scaled down *after* solving rather than by searching for a smaller
      // card: what fits is a fact about the screen, and how much of that a
      // layout wants to use is a choice about the layout. Keeping them
      // separate means a family can be given more or less room without
      // touching the model of what fits.
      return derive(Math.max(MIN_CARD_W, Math.round(cardW * CARD_SCALE[family])), compact);
    }
  }
  return derive(MIN_CARD_W, compact);
}

/** The desktop measurements, for anything that has no box to measure yet. */
export const DEFAULT_METRICS: Metrics = derive(DESKTOP_CARD_W, false);

export interface Placement {
  x: number;
  y: number;
  rotate: number;
  /** Stacking order within the table. */
  z: number;
}

/**
 * Where a card turns when it is fanned: low down, near the bottom edge, the
 * way cards pivot between your fingers rather than about their middles.
 *
 * Exported rather than left in the stylesheet because anything that has to sit
 * *on* a rotated card -- the one-tap play button -- has to turn about the same
 * point to land on it. A pivot that only CSS knows about cannot be shared, and
 * a button placed at the card's unrotated middle misses by nine pixels on a
 * fanned card, which is exactly the sort of thing that reads as "the button is
 * broken".
 */
export const FAN_PIVOT = { x: 0.5, y: 0.9 };

/**
 * The gap between the top edge of a card and the play button floating over it.
 *
 * The button sits *outside* the card, not on it. Anywhere on the face covers
 * part of what you are about to commit -- and on a fanned hand it also covers
 * the neighbouring card, so the button appeared to belong to whichever card
 * you were not looking at.
 */
export const PLAY_BUTTON_GAP = 6;

/**
 * How far above a card's top edge the middle of that button falls, as a
 * fraction of the card's height.
 *
 * Given as a fraction because the button is placed with `cardPoint`, which
 * works in the card's own turned frame -- so the button rides above a fanned
 * card square to the card, not square to the screen.
 */
export function playButtonY(m: Metrics, buttonSize: number): number {
  return -(buttonSize / 2 + PLAY_BUTTON_GAP) / m.cardH;
}

/**
 * A point inside a card, given as fractions of its width and height, in the
 * table's coordinates -- with the card's own rotation applied.
 */
export function cardPoint(m: Metrics, p: Placement, fx: number, fy: number): { x: number; y: number } {
  const pivotX = m.cardW * FAN_PIVOT.x;
  const pivotY = m.cardH * FAN_PIVOT.y;
  // The point, as an offset from the pivot, turned by the card's own angle.
  const vx = m.cardW * fx - pivotX;
  const vy = m.cardH * fy - pivotY;
  const angle = (p.rotate * Math.PI) / 180;
  return {
    x: p.x + pivotX + vx * Math.cos(angle) - vy * Math.sin(angle),
    y: p.y + pivotY + vx * Math.sin(angle) + vy * Math.cos(angle),
  };
}

/** Where the middle of a card actually ends up, once it has been turned. */
export function cardCentre(m: Metrics, p: Placement): { x: number; y: number } {
  return cardPoint(m, p, 0.5, 0.5);
}

/**
 * Everyone sees themselves at the bottom of the table, exactly as everyone at
 * a real table sees their own hand nearest to them. Seats are rotated per
 * client rather than assigned absolutely.
 */
export function seatAngle(state: GameState, playerId: PlayerId, you: PlayerId | null): number {
  const order = state.seatOrder;
  const total = Math.max(order.length, 1);
  const yourIndex = you ? Math.max(order.indexOf(you), 0) : 0;
  const theirIndex = order.indexOf(playerId);
  const relative = ((theirIndex - yourIndex) % total + total) % total;
  return 90 + (360 * relative) / total;
}

/**
 * Seats for a game with a layout in the middle of the table.
 *
 * The ellipse works when the centre is a deck and a discard pile. Four rows of
 * thirteen cards need the whole width, so opponents move to a strip along the
 * top instead -- which is also how people sit around a real game of Sevens,
 * with the layout claiming the middle.
 */
export function topStripSeat(m: Metrics, index: number, total: number, width: number): SeatLayout {
  const x = (width * (index + 1)) / (total + 1);
  // The cards clear the name plate rather than starting underneath it: half a
  // plate, a gap, then half a card.
  return { badge: { x, y: 26 }, hand: { x, y: 26 + m.nameBand / 2 + m.nameGap + m.cardH / 2 } };
}

/**
 * A player's row of face-down stacks, spread in front of them.
 *
 * Five small piles side by side, the way they sit on a real table -- close
 * enough to read as one row belonging to one person, far enough apart to tap.
 */
export function stackRowPosition(
  m: Metrics,
  index: number,
  total: number,
  centre: { x: number; y: number },
): { x: number; y: number } {
  const gap = m.cardW * 1.12;
  const offset = index - (total - 1) / 2;
  return { x: centre.x + offset * gap, y: centre.y };
}

/**
 * The free space either side of the trick.
 *
 * The drop area is a fixed number of cards wide and centred, so whatever is
 * left at the edges of that band is reliably empty at any width -- which makes
 * it the one dependable home for something small on a crowded screen.
 */
export function trickBandMargin(m: Metrics, width: number): number {
  return Math.max(0, (width - TRICK_WIDTH * m.cardW) / 2);
}

export interface StackTableRows {
  /** The opponent's name plate, above their stacks. */
  opponentName: number;
  opponentStacks: number;
  trick: number;
  ownStacks: number;
  hand: number;
}

/**
 * The rows of a 7-8 table, spaced to fit whatever height there is.
 *
 * Fixed offsets work right up until the box changes size. Measuring the
 * content and sharing out what is left over cannot collide at any height --
 * and it means the opponent's name plate gets a band of its own rather than
 * landing at the same height as the cards it is labelling.
 *
 * `height` is the room actually available, so the caller subtracts anything
 * reserved below the table before calling.
 */
export function stackTableRows(m: Metrics, height: number): StackTableRows {
  const opponentBlock = m.nameBand + m.nameGap + m.cardH + m.peek;
  const trickBand = m.cardH;
  const ownBand = m.cardH + m.peek;
  const handBand = m.cardH + m.fanLift;

  const content = opponentBlock + trickBand + ownBand + handBand;
  const gap = Math.max(6, (height - content) / 5);

  let y = gap;
  const opponentName = y + m.nameBand / 2;
  const opponentStacks = y + m.nameBand + m.nameGap + m.cardH / 2;
  y += opponentBlock + gap;
  const trick = y + m.cardH / 2;
  y += trickBand + gap;
  const ownStacks = y + m.cardH / 2;
  y += ownBand + gap;
  const hand = y + m.cardH / 2;

  return { opponentName, opponentStacks, trick, ownStacks, hand };
}

/**
 * Where a suit row sits, between the opponents' strip and your hand.
 *
 * Both edges are hard limits, so the rows share whatever is left between
 * them. Four rows of full-height cards do not comfortably fit a short window,
 * and they overlap rather than spilling into the hand -- a row is a horizontal
 * spread that is mostly empty, so overlapping reads far better than colliding
 * with the cards you are holding.
 */
export function rowBand(m: Metrics, index: number, total: number, height: number): number {
  const top = rowsTop(m);
  const bottom = handTop(m, height) - rowHandGap(m);

  // Space for one whole card plus a step for each row after it. The floor is
  // the same slice the fit model paid for, so the solver has already made room.
  const available = Math.max(m.cardH, bottom - top);
  const step = Math.max(m.rowExposure * m.cardH, (available - m.cardH) / Math.max(total - 1, 1));

  // Positioned by the card's top edge rather than by the band's centre: with
  // rows closer together than a card is tall, a centre-based offset pushes the
  // first row up above where the rows were supposed to start.
  return top + m.cardH / 2 + step * index;
}

export interface SeatLayout {
  /** Where the player's name plate sits, on the outside of the table. */
  badge: { x: number; y: number };
  /** Where their cards fan, just inside it. */
  hand: { x: number; y: number };
}

/**
 * A seat around the ellipse.
 *
 * The name plate goes on the rail and the cards sit inside it, so the two
 * never overlap however many people are at the table. Both are clamped into
 * the surface -- a seat that renders off the top edge is invisible, and with
 * two players the far seat is exactly at the top.
 */
export function seatLayout(m: Metrics, angleDeg: number, width: number, height: number): SeatLayout {
  const radians = (angleDeg * Math.PI) / 180;
  const centreX = width / 2;
  const centreY = height / 2;
  const x = centreX + width * 0.38 * Math.cos(radians);
  const y = centreY + height * 0.40 * Math.sin(radians);

  // Unit vector pointing back at the middle of the table.
  const toCentre = { x: centreX - x, y: centreY - y };
  const length = Math.hypot(toCentre.x, toCentre.y) || 1;

  return {
    badge: {
      x: clamp(x, 70, width - 70),
      y: clamp(y, 24, height - 24),
    },
    hand: {
      x: x + (toCentre.x / length) * m.cardH * 0.62,
      y: y + (toCentre.y / length) * m.cardH * 0.62,
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * A small pile whose buried cards are slid out from under the one covering
 * them, so their backs show.
 *
 * A deck can afford to read as a solid block, but a 7-8 table stack cannot: a
 * face-up card with a card underneath and a face-up card with nothing
 * underneath are completely different to play against, and at a real table you
 * can see the difference at a glance. Squaring them up would hide the one fact
 * about the stack that matters.
 */
export function pairedStackPlacement(
  m: Metrics,
  index: number,
  count: number,
  origin: { x: number; y: number },
): Placement {
  // The topmost card sits at the origin; everything under it peeks out below.
  const beneath = count - 1 - index;
  return {
    x: origin.x - m.cardW / 2 + beneath * m.peek * 0.3,
    y: origin.y - m.cardH / 2 + beneath * m.peek,
    rotate: 0,
    z: index,
  };
}

/** A stacked pile: a few pixels of offset so it reads as having depth. */
export function stackPlacement(m: Metrics, index: number, count: number, origin: { x: number; y: number }): Placement {
  const depth = Math.min(index, 8);
  const step = m.cardW * (0.6 / DESKTOP_CARD_W);
  return {
    x: origin.x - m.cardW / 2 + depth * step,
    y: origin.y - m.cardH / 2 - depth * step,
    rotate: 0,
    z: index,
  };
}

/**
 * A fanned hand. The cards arc, and the arc tightens as the hand grows so a
 * big hand still fits without the ends leaving the table.
 */
export function fanPlacement(
  m: Metrics,
  index: number,
  count: number,
  origin: { x: number; y: number },
  maxWidth: number,
): Placement {
  if (count === 1) {
    return { x: origin.x - m.cardW / 2, y: origin.y - m.cardH / 2, rotate: 0, z: 0 };
  }

  const middle = (count - 1) / 2;
  const offset = index - middle;
  const gap = Math.min(m.cardW * 0.62, (maxWidth - m.cardW) / Math.max(count - 1, 1));
  const spread = Math.min(4, 34 / count);
  const rotate = offset * spread;
  // Cards further from the middle sit slightly lower, the way a hand held in
  // one hand does. Capped in absolute terms rather than growing with the
  // square of the offset -- Sevens deals thirteen cards or more each, and an
  // uncapped arc drops the outer cards straight off the bottom of the screen.
  const lift = middle === 0 ? 0 : (offset / middle) ** 2 * m.fanLift;

  return {
    x: origin.x - m.cardW / 2 + offset * gap,
    y: origin.y - m.cardH / 2 + lift,
    rotate,
    z: index,
  };
}

/** A small deterministic jitter, so a pile dropped on the table is not surgical. */
export function scatter(cardId: string): { dx: number; dy: number; rotate: number } {
  let hash = 0;
  for (let i = 0; i < cardId.length; i++) hash = (hash * 31 + cardId.charCodeAt(i)) | 0;
  const a = ((hash >>> 0) % 1000) / 1000;
  const b = ((hash >>> 10) % 1000) / 1000;
  return { dx: (a - 0.5) * 6, dy: (b - 0.5) * 6, rotate: (a - 0.5) * 7 };
}

/**
 * A Sevens row: cards sit at a fixed slot for their rank, not in the order
 * they happened to be played.
 *
 * That is what makes the layout readable. The seven lands dead centre and the
 * row grows outward from it, so a glance at the table tells you what is
 * playable -- which is exactly what looking at a real layout gives you.
 */
export function rowPlacement(m: Metrics, rank: string, origin: { x: number; y: number }, maxWidth: number): Placement {
  const gap = Math.min(m.cardW * 0.62, maxWidth / 13);
  const fromSeven = rankValue(rank as 'A') - 7;
  return {
    x: origin.x - m.cardW / 2 + fromSeven * gap,
    y: origin.y - m.cardH / 2,
    rotate: 0,
    z: 7 - Math.abs(fromSeven), // the seven underneath, the row overlapping outward
  };
}

export function placementsFor(
  m: Metrics,
  zone: Zone,
  bounds: { width: number; height: number },
  origin: { x: number; y: number },
  cardPos: (cardId: string) => { x: number; y: number } | undefined,
  rank_: (cardId: string) => string | undefined = () => undefined,
): Map<string, Placement> {
  const out = new Map<string, Placement>();

  zone.cards.forEach((cardId, index) => {
    if (zone.kind === 'stack') {
      out.set(cardId, pairedStackPlacement(m, index, zone.cards.length, origin));
      return;
    }

    if (zone.kind === 'row') {
      const rank = rank_(cardId);
      if (rank) {
        out.set(cardId, rowPlacement(m, rank, origin, bounds.width * 0.62));
        return;
      }
    }

    switch (zone.layout) {
      case 'free': {
        const pos = cardPos(cardId);
        const jitter = scatter(cardId);
        out.set(cardId, {
          x: (pos ? pos.x * bounds.width : origin.x) - m.cardW / 2 + (pos ? 0 : jitter.dx),
          y: (pos ? pos.y * bounds.height : origin.y) - m.cardH / 2 + (pos ? 0 : jitter.dy),
          rotate: pos ? 0 : jitter.rotate,
          z: index,
        });
        return;
      }
      case 'fan':
        out.set(cardId, fanPlacement(m, index, zone.cards.length, origin, bounds.width * 0.7));
        return;
      case 'spread':
        out.set(cardId, {
          x: origin.x - m.cardW / 2 + index * m.cardW * 0.35,
          y: origin.y - m.cardH / 2,
          rotate: 0,
          z: index,
        });
        return;
      default:
        out.set(cardId, stackPlacement(m, index, zone.cards.length, origin));
    }
  });

  return out;
}
