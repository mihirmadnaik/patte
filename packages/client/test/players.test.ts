/**
 * A colour per seat.
 *
 * The whole value of a colour is that it is the same thing for everybody at
 * the table -- "I played the blue one" has to mean one card. Everyone sees
 * themselves at the bottom of the table, so anything derived from a viewer's
 * own ordering would quietly give two players different answers.
 */

import { describe, expect, it } from 'vitest';
import { OFFERED_RULESETS, type GameState, type PlayerId } from '@patte/core';
import { SEAT_COLOURS, cardColour, seatColour } from '../src/players.js';

function table(seats: Record<PlayerId, number>, playedBy: Record<string, PlayerId> = {}): GameState {
  return {
    players: Object.fromEntries(
      Object.entries(seats).map(([id, seat]) => [id, { id, name: id, seat, connected: true, isOwner: false }]),
    ),
    seatOrder: Object.keys(seats),
    playedBy,
  } as unknown as GameState;
}

describe('a colour per seat', () => {
  it('gives each seat at a full table a different colour', () => {
    const state = table({ ana: 0, ben: 1, cal: 2, dev: 3 });
    const colours = ['ana', 'ben', 'cal', 'dev'].map((id) => seatColour(state, id));
    expect(new Set(colours).size).toBe(4);
    expect(colours.every((colour) => colour !== undefined)).toBe(true);
  });

  /**
   * The palette has to keep up with the biggest game on offer.
   *
   * Written against the rulesets rather than against a number, because the
   * number is exactly what went wrong: there were four colours and
   * `seat % 4`, so the fifth player at a table was handed the first player's
   * amber and two people shared a mark. Asserting "ten" here would need
   * editing by whoever next seats eleven, and would not fail until they did.
   */
  it('has a colour for every seat the largest game can fill', () => {
    const biggest = Math.max(...OFFERED_RULESETS.map((ruleset) => ruleset.maxPlayers));
    expect(SEAT_COLOURS.length).toBeGreaterThanOrEqual(biggest);
  });

  it('gives the biggest table a different colour for every seat', () => {
    const biggest = Math.max(...OFFERED_RULESETS.map((ruleset) => ruleset.maxPlayers));
    const seats = Object.fromEntries(
      Array.from({ length: biggest }, (_, i) => [`p${i}`, i]),
    ) as Record<PlayerId, number>;
    const state = table(seats);

    const colours = Object.keys(seats).map((id) => seatColour(state, id));
    expect(colours.every((colour) => colour !== undefined), 'a seat with no colour').toBe(true);
    expect(new Set(colours).size, 'two seats sharing a colour').toBe(biggest);
  });

  it('is every colour distinct in the first place', () => {
    expect(new Set(SEAT_COLOURS).size).toBe(SEAT_COLOURS.length);
  });

  it('leaves a seat past the end of the palette unmarked, rather than wrapping', () => {
    // A borrowed colour says something false -- that two players are one --
    // where a missing one only says nothing.
    const state = table({ ana: SEAT_COLOURS.length });
    expect(seatColour(state, 'ana')).toBeUndefined();
  });

  it('is the seat, not the viewer, so every screen agrees', () => {
    // The same table, with the seating listed from two different starting
    // points -- which is what `seatOrder` looks like to two different clients
    // once each has rotated itself to the bottom.
    const mine = table({ ana: 0, ben: 1, cal: 2, dev: 3 });
    const theirs = { ...mine, seatOrder: ['cal', 'dev', 'ana', 'ben'] } as GameState;
    for (const id of ['ana', 'ben', 'cal', 'dev']) {
      expect(seatColour(theirs, id), id).toBe(seatColour(mine, id));
    }
  });

  it('does not recolour the table when somebody leaves', () => {
    // Keyed on the seat, which is kept, rather than on a position in the
    // seating, which closes up.
    const before = table({ ana: 0, ben: 1, cal: 2, dev: 3 });
    const after = table({ ana: 0, cal: 2, dev: 3 });
    for (const id of ['ana', 'cal', 'dev']) {
      expect(seatColour(after, id), id).toBe(seatColour(before, id));
    }
  });

  it('has nothing to say about a player who is not seated', () => {
    expect(seatColour(table({ ana: 0 }), 'nobody')).toBeUndefined();
  });

  it('marks a card with the colour of whoever played it', () => {
    const state = table({ ana: 0, ben: 1 }, { SA: 'ben' });
    expect(cardColour(state, 'SA')).toBe(seatColour(state, 'ben'));
    expect(SEAT_COLOURS).toContain(cardColour(state, 'SA'));
  });

  it('leaves a card nobody has played unmarked', () => {
    // Cards in a hand are dropped from `playedBy` by the engine, so a hand
    // does not turn into a column of identical marks.
    expect(cardColour(table({ ana: 0 }), 'SA')).toBeUndefined();
  });
});
