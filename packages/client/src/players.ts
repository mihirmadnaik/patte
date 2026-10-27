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
 * A colour for every seat the biggest table has.
 *
 * There were four of these, from when four was the largest game here, and
 * `seat % length` meant the fifth player was handed the first player's amber
 * all over again -- two people at one table with one colour, which is worse
 * than no colour at all, since the whole point is to be able to say "the
 * amber one" and be understood. बदाम सात has seated eight all along; जजमेंट
 * seats ten.
 *
 * They have to hold up in two places at once -- a few pixels on a white card,
 * and a dot on dark green felt -- which rules out anything very pale or very
 * dark. Within that, they are picked to differ in lightness as well as in
 * hue, so that the warm end (amber, coral, brown, olive) stays legible as
 * four different marks under the commonest colour blindness, where the hues
 * themselves converge. Ten categories is past the point where hue alone can
 * do it; the name plate carries the same dot beside the name, so a colour is
 * always something you can look up rather than something you must decode.
 *
 * The first four are unchanged, so every game that existed before looks
 * exactly as it did.
 */
export const SEAT_COLOURS = [
  '#f0a93a', // amber
  '#3d9bff', // blue
  '#e5509b', // magenta
  '#36c98a', // green
  '#a67bf5', // violet
  '#f4624a', // coral
  '#1fb8c4', // teal
  '#b9c436', // olive
  '#b07a4e', // brown
  '#8fa3b8', // slate
] as const;

/**
 * The colour of a player's seat.
 *
 * Keyed on `seat`, which is handed out when somebody sits down and does not
 * move, rather than on a position in `seatOrder`, which closes up when a
 * player leaves and would quietly recolour everybody still at the table.
 *
 * A seat past the end of the palette gets no colour rather than wrapping
 * round to somebody else's. Seats are handed out lowest-free-first, so with
 * ten colours and ten seats at the biggest table this cannot arise today --
 * but if a larger game is ever added, it should arrive as an unmarked card
 * and an obvious gap, not as two players quietly sharing a mark.
 */
export function seatColour(state: GameState, playerId: PlayerId): string | undefined {
  const seat = state.players[playerId]?.seat;
  if (seat === undefined) return undefined;
  return SEAT_COLOURS[seat];
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
