/**
 * The visibility boundary -- the most security-critical code in the project.
 *
 * A client is never sent the face of a card it is not entitled to see. Not
 * hidden behind a CSS class, not sent-but-flagged: absent from the payload.
 * Face data that never leaves the server cannot be read out of the network
 * tab, which is why server authority is a founding decision here rather than a
 * later hardening pass.
 *
 * Everything else about a card -- where it is, which way up, who is holding it
 * -- is public, exactly as it is at a physical table.
 */

import { CARRIES_FACES, type GameEvent, type EventBody } from './intents.js';
import {
  getZone,
  tryZone,
  type Card,
  type CardId,
  type Face,
  type GameState,
  type PlayerId,
} from './state.js';

/**
 * The single predicate that decides whether a viewer may know a card's face.
 *
 * A viewer of `null` is a spectator, who sees only what is face up.
 */
export function canSeeFace(state: GameState, card: Card, viewer: PlayerId | null): boolean {
  if (card.faceUp) return true;

  const zone = tryZone(state, card.zone);
  if (!zone) return false;

  // A table option can open every hand -- useful when teaching a game.
  if (zone.kind === 'hand' && !state.options.handsArePrivate) return true;

  if (zone.faceDownVisibleTo === 'all') return true;

  if (viewer === null) return false;

  if (zone.faceDownVisibleTo === 'owner' && zone.owner === viewer) return true;

  return card.revealedTo.includes(viewer);
}

/** The set of cards whose faces `viewer` may currently know. */
export function visibleFaces(state: GameState, viewer: PlayerId | null): Set<CardId> {
  const visible = new Set<CardId>();
  for (const card of Object.values(state.cards)) {
    if (canSeeFace(state, card, viewer)) visible.add(card.id);
  }
  return visible;
}

/**
 * A full snapshot as one viewer is allowed to hold it. Sent on join and on
 * resync after a reconnect.
 */
export function projectFor(state: GameState, viewer: PlayerId | null): GameState {
  const projected = structuredClone(state) as GameState;
  for (const card of Object.values(projected.cards)) {
    if (!canSeeFace(state, card, viewer)) card.face = null;
    // `revealedTo` stays public. At a real table you can see that Ana showed
    // Ben a card even though you cannot see which card it was, and keeping
    // that faithful also means every client holds an identical view of
    // everything except the faces themselves.
  }
  return projected;
}

/**
 * Strip faces a viewer may not see from an outgoing event.
 *
 * Almost every event refers to cards by id alone; only the two that lay out a
 * table carry faces. That is not an accident -- keeping faces out of the event
 * vocabulary is what makes this function small enough to trust.
 *
 * The two that do carry them are named in `CARRIES_FACES` rather than checked
 * inline, so adding a third and forgetting to redact it fails a test instead
 * of leaking quietly.
 */
export function redactEvent(state: GameState, event: GameEvent, viewer: PlayerId | null): GameEvent {
  if (!CARRIES_FACES.has(event.type)) return event;
  if (!('cards' in event)) return event;
  return {
    ...event,
    cards: event.cards.map((card) =>
      canSeeFace(state, card, viewer) ? card : { ...card, face: null },
    ),
  };
}

export interface FacePatch {
  cardId: CardId;
  face: Face;
}

export interface VisibilityDelta {
  /** Faces this viewer has just become entitled to see. */
  learn: FacePatch[];
  /** Faces this viewer is no longer entitled to see, and must drop. */
  forget: CardId[];
}

/**
 * Compare what a viewer is entitled to see against what has already been sent
 * to them, and produce the patch that closes the gap.
 *
 * `forget` matters: a card shuffled back into the deck must stop being known
 * to the client, even though the human already saw it. The person cannot
 * unlearn it, but the client must, or every card that ever passed through a
 * hand would accumulate in an easily-dumped local store.
 */
export function visibilityDelta(
  state: GameState,
  viewer: PlayerId | null,
  alreadySent: Set<CardId>,
): VisibilityDelta {
  const visible = visibleFaces(state, viewer);
  const learn: FacePatch[] = [];
  const forget: CardId[] = [];

  for (const cardId of visible) {
    if (alreadySent.has(cardId)) continue;
    const face = state.cards[cardId]?.face;
    if (face) learn.push({ cardId, face });
  }

  for (const cardId of alreadySent) {
    if (!visible.has(cardId)) forget.push(cardId);
  }

  return { learn, forget };
}

/**
 * The faces returned by a peek. Deliberately not part of state: a peek is a
 * one-shot look delivered to the peeker alone, so there is nothing for another
 * client's copy of the state to leak.
 */
export function peekFaces(state: GameState, cardIds: CardId[]): FacePatch[] {
  const patches: FacePatch[] = [];
  for (const cardId of cardIds) {
    const face = state.cards[cardId]?.face;
    if (face) patches.push({ cardId, face });
  }
  return patches;
}

/** Applied client-side to fold a `VisibilityDelta` into the local state. */
export function applyVisibilityDelta(state: GameState, delta: VisibilityDelta): GameState {
  const next = structuredClone(state) as GameState;
  for (const patch of delta.learn) {
    const card = next.cards[patch.cardId];
    if (card) card.face = patch.face;
  }
  for (const cardId of delta.forget) {
    const card = next.cards[cardId];
    if (card) card.face = null;
  }
  return next;
}

export type { EventBody };
export { getZone };
