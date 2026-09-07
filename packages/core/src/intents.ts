/**
 * Intents and events.
 *
 * An *intent* is what a client asks for. It may be ambiguous ("toggle these
 * cards"), may depend on state the client cannot see, and may require
 * randomness ("shuffle the deck").
 *
 * An *event* is what actually happened. It is fully resolved: every index,
 * every permutation and every face-up flag is spelled out. Events are the only
 * thing the reducer consumes, which is what makes the reducer pure and the log
 * exactly replayable.
 *
 * Resolution (intent -> event) happens in `resolve.ts` and is the only place
 * randomness or hidden information is consulted.
 */

import type { CardId, Card, PlayerId, Point, TableOptions, ZoneId, Zone } from './state.js';

// --- intents ---------------------------------------------------------------

export interface MoveTarget {
  toZone: ZoneId;
  /** Insertion index; appended to the end when omitted. */
  toIndex?: number;
  /** Position within a `free` zone. */
  pos?: Point;
}

export type Intent =
  | ({ type: 'grab'; cardIds: CardId[] })
  | ({ type: 'release'; cardIds: CardId[] })
  | ({ type: 'move'; cardIds: CardId[] } & MoveTarget)
  /** `faceUp` omitted means toggle each card individually. */
  | ({ type: 'flip'; cardIds: CardId[]; faceUp?: boolean })
  | ({ type: 'shuffle'; zoneId: ZoneId })
  | ({ type: 'reveal'; cardIds: CardId[]; to: PlayerId[] | 'all' })
  | ({ type: 'peek'; cardIds: CardId[] })
  /** Convenience macro. Expands into a sequence of moves at resolve time. */
  | ({ type: 'deal'; fromZone: ZoneId; count: number; toZones?: ZoneId[]; faceUp?: boolean })
  | ({ type: 'gather'; toZone: ZoneId })
  /**
   * Deal the next round under the table's ruleset.
   *
   * `reset` clears the running scores and starts a fresh match; without it the
   * round is added to the match already in progress.
   */
  | ({ type: 'startGame'; reset?: boolean })
  /**
   * Ask the table to abandon this hand and deal again.
   *
   * Separate from `startGame` because it needs an answer: the asker has seen
   * their cards, so an unchecked redeal is a way to shop for a better hand.
   */
  | ({ type: 'proposeRedeal'; reset?: boolean })
  /** Answer a redeal somebody has asked for. The asker may answer to cancel. */
  | ({ type: 'answerRedeal'; agree: boolean })
  /** Change how many rounds the match runs to. */
  | ({ type: 'setMatchRounds'; rounds: number })
  /** Stop here. A round in progress is abandoned rather than scored. */
  | ({ type: 'endMatch' })
  /**
   * A structured choice the ruleset asked for: naming trump, bidding, picking
   * a suit after an eight. Deliberately opaque to the engine -- the ruleset
   * decides what the options mean and whether this one is allowed.
   */
  | ({ type: 'choose'; option: string })
  | ({ type: 'passTurn' })
  | ({ type: 'setTurn'; playerId: PlayerId | null })
  | ({ type: 'declare'; text: string })
  | ({ type: 'adjustScore'; playerId: PlayerId; delta: number })
  | ({ type: 'setOption'; key: keyof TableOptions; value: boolean | number })
  | ({ type: 'rename'; name: string });

export type IntentType = Intent['type'];

// --- events ----------------------------------------------------------------

export interface CardPlacement {
  cardId: CardId;
  toZone: ZoneId;
  toIndex: number;
  pos?: Point;
}

export interface CardFlip {
  cardId: CardId;
  faceUp: boolean;
}

/**
 * Intents about the *table* rather than about the game being played on it.
 *
 * A ruleset decides what is a legal move; it does not decide whether people
 * may agree to deal again, rename themselves, or stop. Kept here so that the
 * next ruleset cannot forget one of them and quietly make a table
 * unadministrable in the middle of a hand -- which is exactly what happened
 * when the redeal request was added and the trump call refused it.
 */
export const TABLE_INTENTS: readonly Intent['type'][] = [
  'startGame',
  'proposeRedeal',
  'answerRedeal',
  'setMatchRounds',
  'endMatch',
  'declare',
  'rename',
];

export type EventBody =
  | { type: 'tableCreated'; zones: Zone[]; cards: Card[]; options: TableOptions; rulesetId: string }
  /**
   * A fresh deal. Replaces the zones and the pack wholesale rather than
   * patching what was there, so starting a second game cannot inherit a stray
   * card from the first.
   */
  | {
      type: 'gameStarted';
      zones: Zone[];
      cards: Card[];
      options: TableOptions;
      inPlay: PlayerId[];
      firstTurn: PlayerId | null;
    }
  | { type: 'gameEnded'; rankings: PlayerId[]; scores: Record<PlayerId, number> }
  | { type: 'redealProposed'; by: PlayerId; waitingOn: PlayerId[]; reset: boolean }
  | { type: 'redealAnswered'; playerId: PlayerId; agree: boolean }
  /** The request is over: refused, cancelled, or carried out. */
  | { type: 'redealWithdrawn' }
  | { type: 'matchRoundsSet'; rounds: number }
  | { type: 'matchReset' }
  | { type: 'matchEnded' }
  | { type: 'chosen'; by: PlayerId; option: string }
  | { type: 'gameDataSet'; key: string; value: string | number | boolean }
  | { type: 'playerJoined'; playerId: PlayerId; name: string; seat: number; isOwner: boolean; handZone: Zone }
  | { type: 'playerLeft'; playerId: PlayerId }
  | { type: 'playerConnection'; playerId: PlayerId; connected: boolean }
  | { type: 'playerRenamed'; playerId: PlayerId; name: string }
  | { type: 'cardsGrabbed'; cardIds: CardId[]; by: PlayerId }
  | { type: 'cardsReleased'; cardIds: CardId[] }
  | { type: 'cardsMoved'; placements: CardPlacement[] }
  | { type: 'cardsFlipped'; flips: CardFlip[] }
  | { type: 'zoneShuffled'; zoneId: ZoneId; order: CardId[] }
  | { type: 'cardsRevealed'; cardIds: CardId[]; to: PlayerId[] }
  | { type: 'cardsPeeked'; cardIds: CardId[]; by: PlayerId }
  | { type: 'turnSet'; playerId: PlayerId | null }
  | { type: 'declared'; by: PlayerId; text: string }
  | { type: 'scoreAdjusted'; playerId: PlayerId; delta: number }
  | { type: 'optionSet'; key: keyof TableOptions; value: boolean | number };

export interface EventEnvelope {
  seq: number;
  at: number;
  /** Null for events the server originates on its own, such as lock expiry. */
  actor: PlayerId | null;
}

export type GameEvent = EventEnvelope & EventBody;
export type EventType = EventBody['type'];

/**
 * Events that can never be undone. Once a player has seen a card there is no
 * making them un-see it, and pretending otherwise is worse than refusing.
 */
export const IRREVERSIBLE: ReadonlySet<EventType> = new Set<EventType>([
  'cardsRevealed',
  'cardsPeeked',
  'zoneShuffled',
]);

/**
 * Events that carry card faces and therefore must be redacted per viewer.
 *
 * Kept as a list rather than a check at each call site so that adding an event
 * with a `cards` field and forgetting to redact it is a test failure rather
 * than a silent leak.
 */
export const CARRIES_FACES: ReadonlySet<EventType> = new Set<EventType>([
  'tableCreated',
  'gameStarted',
]);

// --- results ---------------------------------------------------------------

export type Denied = { ok: false; reason: string };
export type Resolved = { ok: true; events: EventBody[] };
export type Resolution = Resolved | Denied;

export function deny(reason: string): Denied {
  return { ok: false, reason };
}

export function resolved(...events: EventBody[]): Resolved {
  return { ok: true, events };
}
