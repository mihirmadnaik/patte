/**
 * Asking the rules a question early.
 *
 * In a trick game most of a player's waiting is spent on a decision that has
 * already been made for them: the moment the lead is down, what they may play
 * is settled -- follow the suit if they hold it, anything if they do not --
 * and the only thing still missing is the turn. A pre-move is that decision,
 * taken when it becomes available rather than when it becomes actionable.
 *
 * What stands in the way is that every `legalCards` begins by refusing anyone
 * who is not on turn, which is right for its own job (the client lights up
 * what may be played *now*) and useless for this one.
 *
 * So this asks the same question with the turn moved, which is sound exactly
 * when the ruleset says it is -- see `Ruleset.premoveReady`. It is a read of
 * a throwaway copy: nothing is committed, no event is produced, and the
 * ruleset remains the only thing in the program that knows what is legal.
 */

import type { CardId, GameState, PlayerId, ZoneId } from './state.js';
import type { Ruleset } from './rulesets/types.js';

/**
 * The table as it will be when the turn reaches this player.
 *
 * A throwaway shallow copy, never committed and never reduced over. Kept
 * here rather than written out at each call site so that fabricating a turn
 * -- which is a liberty -- happens in one place that explains itself.
 */
function asIfOnTurn(state: GameState, playerId: PlayerId): GameState {
  return state.turn === playerId ? state : { ...state, turn: playerId };
}

/** What this player could play if the turn reached them now. */
export function legalWhenOnTurn(
  ruleset: Ruleset,
  state: GameState,
  playerId: PlayerId,
): CardId[] {
  return ruleset.legalCards?.(asIfOnTurn(state, playerId), playerId) ?? [];
}

/**
 * Where that card would go.
 *
 * Needed as well as the legal set because every `destinationsFor` here is
 * written in terms of `legalCards`, so it refuses a player who is not on
 * turn for the same reason and has to be asked the same way.
 */
export function destinationsWhenOnTurn(
  ruleset: Ruleset,
  state: GameState,
  playerId: PlayerId,
  cardId: CardId,
): ZoneId[] {
  return ruleset.destinationsFor?.(asIfOnTurn(state, playerId), playerId, cardId) ?? [];
}
