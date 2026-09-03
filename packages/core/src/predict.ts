/**
 * Client-side prediction.
 *
 * A drag has to feel instant, so the client applies its own intents locally
 * and reconciles when the server answers. The rule that keeps this honest:
 * **predict only what you can already see.**
 *
 * Shuffling, dealing and drawing from a face-down pile all depend on
 * information the client does not have. There is nothing to predict there --
 * guessing would either invent a card or flicker when the truth arrived -- so
 * those wait for the server. Moving a card you are already looking at is
 * entirely determined by state you hold, so it can be applied at once and will
 * agree with the server every time.
 */

import type { Intent } from './intents.js';
import { makeRng } from './deck.js';
import { reduce } from './reduce.js';
import { resolve } from './resolve.js';
import { freeplay } from './rulesets/freeplay.js';
import type { Ruleset } from './rulesets/types.js';
import type { GameState, PlayerId } from './state.js';

/** Intents whose outcome follows entirely from what the client can see. */
const PREDICTABLE: ReadonlySet<Intent['type']> = new Set<Intent['type']>([
  'grab',
  'release',
  'move',
  'flip',
]);

export function isPredictable(state: GameState, intent: Intent): boolean {
  if (!PREDICTABLE.has(intent.type)) return false;
  // Flipping a card face up when you cannot see it would mean rendering a face
  // you do not have. Let the server answer that one.
  if (intent.type === 'flip') {
    return intent.cardIds.every((id) => state.cards[id]?.face != null || intent.faceUp === false);
  }
  return true;
}

export interface PendingIntent {
  id: number;
  intent: Intent;
}

/**
 * Rebuild the on-screen state: the last thing the server confirmed, with our
 * own un-acknowledged intents replayed on top.
 *
 * Recomputing from the confirmed snapshot every time -- rather than patching
 * in place -- is what makes reconciliation trivial. Dropping an intent that
 * was denied is just leaving it out of the replay.
 */
export function predict(
  confirmed: GameState,
  pending: PendingIntent[],
  actor: PlayerId,
  ruleset: Ruleset = freeplay,
): GameState {
  if (pending.length === 0) return confirmed;

  // The seed is never used: no predictable intent consumes randomness.
  const deps = { rng: makeRng(0), ruleset };
  let state = confirmed;

  for (const { intent } of pending) {
    if (!isPredictable(state, intent)) continue;
    const outcome = resolve(state, intent, actor, deps);
    if (!outcome.ok) continue; // the server will deny it too; show the truth
    for (const body of outcome.events) {
      state = reduce(state, { ...body, seq: state.seq, at: 0, actor });
    }
  }

  return state;
}
