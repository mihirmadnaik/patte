/**
 * A colour per player, so a card on the table can say whose it is.
 *
 * In a trick-taking game the question you ask of the middle of the table is
 * not "what was led" -- you can see that -- but "who played *that*". Nothing
 * on a card answers it: the cards are identical from every seat, and where
 * one happens to lie is an accident of the order they were played in.
 *
 * Laying each card out under its own player answers it too, and was tried
 * first. This is cheaper in every way that matters on a phone: it costs no
 * table, it survives cards overlapping, it works the same whether three or
 * four people are playing, and it goes on looking right in a pile of won
 * tricks where there is no "under them" to lie.
 *
 * **The colour is the seat, not the screen.** Everyone sees themselves at the
 * bottom of the table, so anything derived from *your* view of the seating
 * would give two players different ideas of who is blue -- and the whole
 * point of a colour is that it is a thing people can say out loud.
 */

import type { GameState, PlayerId } from '@patte/core';

/**
 * Four colours for four seats.
 *
 * Picked to stay apart for the commonest colour blindness as well as for
 * ordinary sight: amber, blue, magenta and green differ in lightness as well
 * as in hue, so the marks read as different even where two of the hues do
 * not. They also have to hold up in two places at once -- a few pixels on a
 * white card, and a dot on a dark green felt -- which rules out anything pale.
 */
export const SEAT_COLOURS = ['#f0a93a', '#3d9bff', '#e5509b', '#36c98a'] as const;

/**
 * The colour of a player's seat.
 *
 * Keyed on `seat`, which is handed out when somebody sits down and does not
 * move, rather than on a position in `seatOrder`, which closes up when a
 * player leaves and would quietly recolour everybody still at the table.
 */
export function seatColour(state: GameState, playerId: PlayerId): string | undefined {
  const seat = state.players[playerId]?.seat;
  if (seat === undefined) return undefined;
  return SEAT_COLOURS[seat % SEAT_COLOURS.length];
}

/**
 * The colour to mark a card with, or nothing if it should not be marked.
 *
 * Only cards that were *played*: the engine records who put each card where
 * it is, and forgets it the moment the card goes back into a hand. Your own
 * hand is unmarked too -- every card in it is yours, so a column of identical
 * marks would be decoration.
 */
export function cardColour(state: GameState, cardId: string): string | undefined {
  const by = state.playedBy[cardId];
  return by ? seatColour(state, by) : undefined;
}
