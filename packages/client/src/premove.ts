/**
 * What to do with a card the player armed before their turn.
 *
 * Pulled out of the component for the reason `auction.ts` was: the client's
 * tests are all pure functions, deliberately, because every rule lives in
 * core -- so the parts of the client that can be got wrong have to be the
 * kind of thing a test can hold.
 *
 * And this one can be got wrong. An armed card is a promise to play something
 * on the player's behalf, so the two failures are opposite and both bad:
 * playing a card after the moment for it has passed, and sitting on one while
 * the table waits. Everything here is about saying exactly when each of those
 * stops being a risk.
 */

import type { CardId, GameState, PlayerId } from '@patte/core';

/**
 * `hold` — keep waiting. `fire` — the turn is here and the card is legal.
 * `drop` — forget it; the moment has gone.
 */
export type PremoveAction = 'hold' | 'fire' | 'drop';

export function premoveAction(args: {
  /** The card the player armed, if any. */
  queued: CardId | null;
  state: GameState | null;
  you: PlayerId | null;
  /** What the rules allow right now: `legalCards(state, you)`. */
  legalNow: readonly CardId[];
}): PremoveAction {
  const { queued, state, you, legalNow } = args;
  if (!queued || !state || !you) return 'hold';

  // A hand that is over takes its arming with it. Said before anything about
  // turns, because a finished hand still has a `turn` on it.
  if (state.phase !== 'playing') return 'drop';

  // Gone from the hand it was armed from -- played, withdrawn for a वख्खै, or
  // swept up by a redeal. Whatever happened to it, it is not ours to play.
  if (state.cards[queued]?.zone !== `hand:${you}`) return 'drop';

  if (state.turn !== you) return 'hold';

  // The turn is here. The window is built so that an armed card is always
  // still legal when it arrives -- but "built so that" is not "guaranteed",
  // and the cost of being wrong is a card played against the rules, so the
  // last word is the rules' rather than ours.
  return legalNow.includes(queued) ? 'fire' : 'drop';
}
