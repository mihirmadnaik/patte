/**
 * The wire protocol, defined once and shared by both ends.
 *
 * The shape to notice: clients send *intents* and receive *events*. A client
 * never announces what happened, only what it would like to happen, and the
 * server is the only thing that decides. Every message below follows from
 * that.
 */

import type { GameEvent, Intent } from './intents.js';
import type { FacePatch } from './project.js';
import type { CardId, GameState, PlayerId, ZoneId } from './state.js';

export const PROTOCOL_VERSION = 1;

// --- client -> server ------------------------------------------------------

export type ClientMessage =
  /** Sent once, immediately after the socket opens. */
  | {
      t: 'hello';
      version: number;
      roomId: string;
      playerId?: PlayerId;
      name: string;
      /** Only honoured when this hello is what opens the room. */
      rulesetId?: string;
    }
  /** `id` is echoed back on denial so the client can roll back that prediction. */
  | { t: 'intent'; id: number; intent: Intent }
  /** Presence only. Never logged, never part of state. */
  | { t: 'cursor'; x: number; y: number; zone?: ZoneId; dx?: number; dy?: number }
  | { t: 'resync' }
  | { t: 'ping' };

// --- server -> client ------------------------------------------------------

export interface Welcome {
  t: 'welcome';
  version: number;
  you: PlayerId;
  /** Already projected: faces this player may not see are null. */
  snapshot: GameState;
}

export interface EventBatch {
  t: 'events';
  events: GameEvent[];
  /** Faces this client has just become entitled to see. */
  learn: FacePatch[];
  /** Faces it must drop. */
  forget: CardId[];
  /** Echoed when this batch is the confirmation of one of our own intents. */
  ack?: number;
}

export type ServerMessage =
  | Welcome
  | EventBatch
  /** A prediction to roll back, with a reason worth showing the player. */
  | { t: 'denied'; id: number; reason: string }
  /** A one-shot private look. Deliberately not part of any state. */
  | { t: 'peeked'; faces: FacePatch[] }
  | { t: 'cursors'; cursors: CursorPosition[] }
  | { t: 'pong' }
  | { t: 'error'; message: string };

/**
 * Where somebody's pointer is, in terms both ends agree on.
 *
 * Raw coordinates do not survive the trip. Every client draws its *own* hand
 * along the bottom edge and everybody else's as a bundle at their seat, so a
 * pointer at "the middle of the bottom" means one player's own cards to the
 * sender and a different player's own cards to the receiver -- which is why
 * an opponent's cursor used to appear over your hand rather than theirs.
 *
 * So a cursor is sent as an offset from whichever zone it is over, and each
 * client re-anchors it to where that zone sits on their screen. Over the
 * shared middle of the table the two agree anyway and `x`/`y` are used
 * directly.
 */
export interface CursorPosition {
  playerId: PlayerId;
  /** Fraction of the table, used when the pointer is over no zone. */
  x: number;
  y: number;
  /** The zone the pointer is over, if any. */
  zone?: ZoneId;
  /** Offset from that zone's origin, as a fraction of the table. */
  dx?: number;
  dy?: number;
}

export function isClientMessage(value: unknown): value is ClientMessage {
  return typeof value === 'object' && value !== null && typeof (value as { t?: unknown }).t === 'string';
}
