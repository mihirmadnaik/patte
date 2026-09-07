import { beforeEach, describe, expect, it } from 'vitest';
import {
  Table,
  cardPoints,
  checkInvariants,
  handValue,
  sevens,
  isPlayable,
  legalCards,
  makeRng,
  OPENING_CARD,
  projectFor,
  rankValue,
  rowZoneId,
  type CardId,
  type GameState,
  type PlayerId,
} from '../src/index.js';

const PLAYERS = ['ana', 'ben', 'cal'];
/**
 * The opener, and the row it lands in, taken from the ruleset rather than
 * spelled out here. Which seven starts the game is the ruleset's business --
 * these tests are about what follows from it.
 */
const OPENER = OPENING_CARD;
const OPENER_SUIT = OPENER[0]!;
const OPENER_ROW = rowZoneId(OPENER_SUIT as 'S');

function sevensTable(seed = 1, players = PLAYERS): Table {
  let clock = 1_700_000_000_000;
  const table = new Table({
    roomId: 'sevens',
    rulesetId: 'sevens',
    rng: makeRng(seed),
    now: () => clock++,
    strict: true,
  });
  table.create();
  for (const name of players) table.addPlayer(name, name);
  return table;
}

function started(seed = 1, players = PLAYERS): Table {
  const table = sevensTable(seed, players);
  const result = table.submit(players[0]!, { type: 'startGame' });
  if (!result.ok) throw new Error(`could not start: ${result.reason}`);
  return table;
}

function handOf(state: GameState, playerId: PlayerId): CardId[] {
  return state.zones[`hand:${playerId}`]?.cards ?? [];
}

function rowOf(state: GameState, suit: string): string[] {
  return (state.zones[rowZoneId(suit as 'S')]?.cards ?? []).map((id) => id);
}

/** Play a whole game by always taking the first legal card, or passing. */
function playOut(table: Table, maxTurns = 400): number {
  let turns = 0;
  while (table.state.phase === 'playing' && turns < maxTurns) {
    const actor = table.state.turn;
    if (!actor) break;
    const playable = legalCards(table.state, actor);
    const result = playable[0]
      ? table.submit(actor, {
          type: 'move',
          cardIds: [playable[0]],
          toZone: rowZoneId(table.state.cards[playable[0]]!.face!.suit!),
        })
      : table.submit(actor, { type: 'passTurn' });
    if (!result.ok) throw new Error(`stuck at turn ${turns}: ${result.reason}`);
    turns++;
  }
  return turns;
}

describe('setting up', () => {
  it('waits in the lobby instead of dealing to an empty table', () => {
    const table = sevensTable();
    expect(table.state.phase).toBe('lobby');
    expect(Object.keys(table.state.cards)).toHaveLength(0);
  });

  it('refuses to start below the minimum player count', () => {
    const table = sevensTable(1, ['ana']);
    const denied = table.submit('ana', { type: 'startGame' });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toMatch(/at least 2 players/);
  });

  it('deals the whole pack out, as evenly as 52 allows', () => {
    const table = started();
    const sizes = PLAYERS.map((p) => handOf(table.state, p).length);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(52);
    // 52 into 3 does not go; a one-card spread is correct, not a bug.
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    expect(checkInvariants(table.state)).toEqual([]);
  });

  it('leaves no undealt cards anywhere on the table', () => {
    const table = started();
    for (const zone of Object.values(table.state.zones)) {
      if (zone.kind !== 'hand') expect(zone.cards).toHaveLength(0);
    }
  });

  it('opens on the seven of hearts, which is what badam saat is named for', () => {
    // Stated outright in exactly one place. Everything else in this file asks
    // the ruleset which card opens, which keeps the tests honest about the
    // rule changing -- but would let the rule change unnoticed if nothing
    // pinned it.
    expect(OPENING_CARD).toBe('H7');
  });

  it('gives the first turn to whoever holds the opening seven', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const table = started(seed);
      const opener = table.state.turn!;
      expect(handOf(table.state, opener)).toContain(OPENER);
    }
  });
});

describe('the opening move', () => {
  it('allows only the opening seven first', () => {
    const table = started();
    const opener = table.state.turn!;
    expect(legalCards(table.state, opener)).toEqual([OPENER]);
  });

  it('refuses another seven before the game is open', () => {
    const table = started();
    const opener = table.state.turn!;
    const otherSeven = handOf(table.state, opener).find((id) => id !== OPENER && id.endsWith('7'));
    if (!otherSeven) return; // this deal did not give the opener a second seven

    const denied = table.submit(opener, {
      type: 'move',
      cardIds: [otherSeven],
      toZone: rowZoneId(table.state.cards[otherSeven]!.face!.suit!),
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toMatch(/opening seven/);
  });

  it("opens the opening seven's row and passes the turn on", () => {
    const table = started();
    const opener = table.state.turn!;
    expect(table.submit(opener, { type: 'move', cardIds: [OPENER], toZone: OPENER_ROW }).ok).toBe(true);
    expect(rowOf(table.state, OPENER_SUIT)).toEqual([OPENER]);
    expect(table.state.turn).not.toBe(opener);
  });
});

describe('legality', () => {
  let table: Table;
  let opener: PlayerId;

  beforeEach(() => {
    table = started();
    opener = table.state.turn!;
    table.submit(opener, { type: 'move', cardIds: [OPENER], toZone: OPENER_ROW });
  });

  it('accepts only the cards either side of a row', () => {
    // With only the opening seven down, its row accepts the six and the eight
    // of that suit and nothing else.
    const of = (rank: string): string => `${OPENER_SUIT}${rank}`;
    expect(isPlayable(table.state, table.state.cards[of('6')]!)).toBe(true);
    expect(isPlayable(table.state, table.state.cards[of('8')]!)).toBe(true);
    expect(isPlayable(table.state, table.state.cards[of('5')]!)).toBe(false);
    expect(isPlayable(table.state, table.state.cards[of('9')]!)).toBe(false);
    // And a suit with nothing down still wants its seven first.
    expect(isPlayable(table.state, table.state.cards['S7']!)).toBe(true);
    expect(isPlayable(table.state, table.state.cards['S8']!)).toBe(false);
  });

  it('will not let a player force the turn to themselves', () => {
    const waiting = PLAYERS.find((p) => p !== table.state.turn)!;
    expect(table.submit(waiting, { type: 'setTurn', playerId: waiting }).ok).toBe(false);
  });

  it('refuses a card played onto the wrong suit row', () => {
    const actor = table.state.turn!;
    const card = handOf(table.state, actor)[0]!;
    const suit = table.state.cards[card]!.face!.suit!;
    const wrongRow = rowZoneId(suit === 'S' ? 'H' : 'S');

    const denied = table.submit(actor, { type: 'move', cardIds: [card], toZone: wrongRow });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toMatch(new RegExp(`belongs on the ${suit} row`));
  });

  it('opens the other suits only with their sevens', () => {
    const actor = table.state.turn!;
    const nonSeven = handOf(table.state, actor).find((id) => {
      const face = table.state.cards[id]!.face!;
      return face.suit !== 'D' && face.rank !== '7';
    })!;
    const suit = table.state.cards[nonSeven]!.face!.suit!;

    const denied = table.submit(actor, { type: 'move', cardIds: [nonSeven], toZone: rowZoneId(suit) });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toMatch(/only be opened with its seven/);
  });

  it('will not let a player act out of turn', () => {
    const waiting = PLAYERS.find((p) => p !== table.state.turn)!;
    const card = handOf(table.state, waiting)[0]!;
    const denied = table.submit(waiting, {
      type: 'move',
      cardIds: [card],
      toZone: rowZoneId(table.state.cards[card]!.face!.suit!),
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toMatch(/your turn/);
  });

  it('still lets a waiting player rearrange their own hand', () => {
    const waiting = PLAYERS.find((p) => p !== table.state.turn)!;
    const hand = handOf(table.state, waiting);
    const reorder = table.submit(waiting, {
      type: 'move',
      cardIds: [hand[3]!],
      toZone: `hand:${waiting}`,
      toIndex: 0,
    });
    expect(reorder.ok).toBe(true);
    expect(handOf(table.state, waiting)[0]).toBe(hand[3]);
    // Tidying is not a play, so the turn must not move.
    expect(table.state.turn).not.toBe(waiting);
  });

  it('has nothing to say about shuffling or dealing, because there is none', () => {
    const actor = table.state.turn!;
    expect(table.submit(actor, { type: 'shuffle', zoneId: OPENER_ROW }).ok).toBe(false);
    expect(table.submit(actor, { type: 'deal', fromZone: OPENER_ROW, count: 1 }).ok).toBe(false);
    expect(table.submit(actor, { type: 'gather', toZone: OPENER_ROW }).ok).toBe(false);
  });
});

describe('you must play if you can', () => {
  it('refuses a pass from a player holding a legal card', () => {
    const table = started();
    const opener = table.state.turn!;
    const denied = table.submit(opener, { type: 'passTurn' });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toMatch(/cannot pass/);
  });

  it('allows a pass exactly when the player is stuck', () => {
    // Play on until somebody genuinely cannot move, then check that -- and
    // only then -- the engine lets them knock.
    const table = started(6);
    let passes = 0;

    for (let turn = 0; turn < 200 && table.state.phase === 'playing'; turn++) {
      const actor = table.state.turn!;
      const playable = legalCards(table.state, actor);

      if (playable.length === 0) {
        expect(table.submit(actor, { type: 'passTurn' }).ok).toBe(true);
        expect(table.state.turn).not.toBe(actor);
        passes++;
        continue;
      }

      // Holding something playable, a pass must be refused every time.
      const refused = table.submit(actor, { type: 'passTurn' });
      expect(refused.ok).toBe(false);

      table.submit(actor, {
        type: 'move',
        cardIds: [playable[0]!],
        toZone: rowZoneId(table.state.cards[playable[0]!]!.face!.suit!),
      });
    }

    expect(passes, 'no player was ever stuck, so the rule went untested').toBeGreaterThan(0);
  });
});

describe('playing a game out', () => {
  it('always reaches a winner, from any deal', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const table = started(seed);
      playOut(table);

      expect(table.state.phase, `seed ${seed} did not finish`).toBe('finished');
      expect(table.state.rankings).toHaveLength(PLAYERS.length);
      // The winner is the one who ran out of cards.
      expect(handOf(table.state, table.state.rankings[0]!)).toHaveLength(0);
      expect(checkInvariants(table.state)).toEqual([]);
    }
  });

  it('ranks the losers by how much they were left holding', () => {
    const table = started(4);
    playOut(table);
    const remaining = table.state.rankings.map((p) => handOf(table.state, p).length);
    expect(remaining).toEqual([...remaining].sort((a, b) => a - b));
  });

  it('builds each row outward from its seven with no gaps', () => {
    const table = started(7);
    playOut(table);

    for (const suit of ['S', 'H', 'D', 'C']) {
      const values = rowOf(table.state, suit)
        .map((id) => rankValue(table.state.cards[id]!.face!.rank))
        .sort((a, b) => a - b);
      if (values.length === 0) continue;
      expect(values).toContain(7); // a row cannot exist without its seven
      // Contiguous: no card can be down without the one before it.
      for (let i = 1; i < values.length; i++) expect(values[i]).toBe(values[i - 1]! + 1);
    }
  });

  it('stops accepting plays once someone has gone out', () => {
    const table = started(2);
    playOut(table);
    const loser = table.state.rankings[1]!;
    const card = handOf(table.state, loser)[0]!;
    const denied = table.submit(loser, {
      type: 'move',
      cardIds: [card],
      toZone: rowZoneId(table.state.cards[card]!.face!.suit!),
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toMatch(/not in play/);
  });

  it('can be dealt again after it ends', () => {
    const table = started(3);
    playOut(table);
    expect(table.submit('ana', { type: 'startGame' }).ok).toBe(true);
    expect(table.state.phase).toBe('playing');
    expect(table.state.rankings).toEqual([]);
    expect(Object.values(table.state.zones).flatMap((z) => z.cards)).toHaveLength(52);
  });

  it('works for every table size the ruleset claims to support', () => {
    for (let count = 2; count <= 8; count++) {
      const players = Array.from({ length: count }, (_, i) => `p${i}`);
      const table = started(count, players);
      playOut(table);
      expect(table.state.phase, `${count} players did not finish`).toBe('finished');
    }
  });
});

describe('hidden information during a game', () => {
  it('shows a player their own hand and nobody else’s', () => {
    const table = started();
    const view = projectFor(table.state, 'ana');
    for (const id of handOf(view, 'ana')) expect(view.cards[id]!.face).not.toBeNull();
    for (const id of handOf(view, 'ben')) expect(view.cards[id]!.face).toBeNull();
  });

  it('makes every card on the layout public', () => {
    const table = started();
    const opener = table.state.turn!;
    table.submit(opener, { type: 'move', cardIds: [OPENER], toZone: OPENER_ROW });

    for (const viewer of [...PLAYERS, null]) {
      expect(projectFor(table.state, viewer).cards[OPENER]!.face).not.toBeNull();
    }
  });

  it('keeps hands private during play and shows them at the end', () => {
    const table = started(5);
    const duringPlay = handOf(table.state, 'ben')[0]!;
    expect(projectFor(table.state, 'ana').cards[duringPlay]!.face).toBeNull();

    playOut(table);

    // Whatever is still in a hand when it ends gets turned over, the way
    // people show what they were stuck with.
    for (const playerId of PLAYERS) {
      for (const cardId of handOf(table.state, playerId)) {
        expect(
          projectFor(table.state, 'ana').cards[cardId]!.face,
          `${cardId} was not shown at the end`,
        ).not.toBeNull();
      }
    }
  });
});

describe('scoring', () => {
  it('values ace as 1, pips as themselves, and the court cards 11 to 13', () => {
    const expected: Record<string, number> = {
      A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
      '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13,
    };
    for (const [rank, points] of Object.entries(expected)) {
      expect(cardPoints(rank as 'A'), `${rank} should be worth ${points}`).toBe(points);
    }
  });

  it('scores a hand as the sum of what is left in it', () => {
    const table = started();
    const player = PLAYERS[0]!;
    const byHand = handOf(table.state, player).reduce(
      (total, id) => total + cardPoints(table.state.cards[id]!.face!.rank),
      0,
    );
    expect(handValue(table.state, player)).toBe(byHand);
  });

  it('gives the winner nothing and everyone else what they were holding', () => {
    const table = started(4);
    playOut(table);

    const round = table.state.match.played.at(-1)!;
    const winner = table.state.rankings[0]!;
    expect(round.scores[winner]).toBe(0);

    for (const playerId of PLAYERS) {
      expect(round.scores[playerId]).toBe(handValue(table.state, playerId));
    }
    // Nobody but the winner escapes with nothing, since they still hold cards.
    for (const playerId of PLAYERS.filter((p) => p !== winner)) {
      expect(round.scores[playerId]).toBeGreaterThan(0);
    }
  });

  it('accounts for all 52 cards worth of points across the table', () => {
    // The whole pack is dealt, so every point is either scored or was played.
    const table = started(8);
    const dealtTotal = Object.values(table.state.cards).reduce(
      (total, card) => total + cardPoints(card.face!.rank),
      0,
    );
    expect(dealtTotal).toBe(4 * (1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10 + 11 + 12 + 13));

    playOut(table);
    const round = table.state.match.played.at(-1)!;
    const stillHeld = PLAYERS.reduce((total, p) => total + handValue(table.state, p), 0);
    const scored = Object.values(round.scores).reduce((a, b) => a + b, 0);
    expect(scored).toBe(stillHeld);
  });

  it('ranks by points, not by card count', () => {
    const table = started(9);
    playOut(table);
    const round = table.state.match.played.at(-1)!;
    const inOrder = round.rankings.map((p) => round.scores[p] ?? 0);
    expect(inOrder).toEqual([...inOrder].sort((a, b) => a - b));
  });
});

describe('a match of several rounds', () => {
  function playRounds(table: Table, count: number): void {
    for (let i = 0; i < count; i++) {
      table.submit(PLAYERS[0]!, { type: 'startGame' });
      playOut(table);
    }
  }

  it('keeps every round and a running total', () => {
    const table = sevensTable(11);
    table.submit(PLAYERS[0]!, { type: 'setMatchRounds', rounds: 3 });
    playRounds(table, 3);

    expect(table.state.match.played).toHaveLength(3);
    expect(table.state.match.rounds).toBe(3);

    const totals = sevens.scoreboard!(table.state);
    for (const entry of totals) {
      const summed = table.state.match.played.reduce(
        (total, round) => total + (round.scores[entry.playerId] ?? 0),
        0,
      );
      expect(entry.value).toBe(summed);
    }
    // The scoreboard leads with whoever is doing best, which here is lowest.
    expect(totals.map((t) => t.value)).toEqual([...totals.map((t) => t.value)].sort((a, b) => a - b));
  });

  it('stretches the match rather than refusing an extra round', () => {
    const table = sevensTable(12);
    table.submit(PLAYERS[0]!, { type: 'setMatchRounds', rounds: 1 });
    playRounds(table, 1);
    expect(table.state.match.played).toHaveLength(1);

    // Play on past the agreed length: the match grows to fit.
    playRounds(table, 1);
    expect(table.state.match.played).toHaveLength(2);
    expect(table.state.match.rounds).toBe(2);
  });

  it('starts a clean match when asked to reset', () => {
    const table = sevensTable(13);
    playRounds(table, 2);
    expect(table.state.match.played).toHaveLength(2);

    table.submit(PLAYERS[0]!, { type: 'startGame', reset: true });
    expect(table.state.match.played).toHaveLength(0);
    expect(table.state.phase).toBe('playing');
  });

  it('ends where it stands, abandoning a round in progress unscored', () => {
    const table = sevensTable(14);
    table.submit(PLAYERS[0]!, { type: 'setMatchRounds', rounds: 5 });
    playRounds(table, 2);

    table.submit(PLAYERS[0]!, { type: 'startGame' }); // third round under way
    expect(table.state.phase).toBe('playing');

    table.submit(PLAYERS[0]!, { type: 'endMatch' });
    expect(table.state.phase).toBe('finished');
    // The abandoned round is not scored, and the match now reads as complete.
    expect(table.state.match.played).toHaveLength(2);
    expect(table.state.match.rounds).toBe(2);
  });

  it('lets only the table owner change the match', () => {
    const table = sevensTable(15);
    const guest = PLAYERS[1]!;
    expect(table.submit(guest, { type: 'setMatchRounds', rounds: 4 }).ok).toBe(false);
    expect(table.submit(guest, { type: 'endMatch' }).ok).toBe(false);
    expect(table.submit(PLAYERS[0]!, { type: 'setMatchRounds', rounds: 4 }).ok).toBe(true);
  });

  it('refuses to shorten a match below the rounds already played', () => {
    const table = sevensTable(16);
    playRounds(table, 2);
    const denied = table.submit(PLAYERS[0]!, { type: 'setMatchRounds', rounds: 1 });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toMatch(/already been played/);
  });
});

describe('the last play', () => {
  it('marks the card just laid down, and who laid it', () => {
    const table = started(17);
    const opener = table.state.turn!;
    expect(table.state.lastPlay).toBeNull();

    table.submit(opener, { type: 'move', cardIds: [OPENER], toZone: OPENER_ROW });
    expect(table.state.lastPlay).toEqual({ cardIds: [OPENER], by: opener });
  });

  it('ignores a player tidying their own hand', () => {
    const table = started(18);
    const opener = table.state.turn!;
    table.submit(opener, { type: 'move', cardIds: [OPENER], toZone: OPENER_ROW });

    const waiting = PLAYERS.find((p) => p !== opener)!;
    const hand = handOf(table.state, waiting);
    table.submit(waiting, { type: 'move', cardIds: [hand[2]!], toZone: `hand:${waiting}`, toIndex: 0 });

    // Still the opening seven: rearranging a hand is not a play.
    expect(table.state.lastPlay).toEqual({ cardIds: [OPENER], by: opener });
  });

  it('is cleared by a fresh deal', () => {
    const table = started(19);
    table.submit(table.state.turn!, { type: 'move', cardIds: [OPENER], toZone: OPENER_ROW });
    expect(table.state.lastPlay).not.toBeNull();

    table.submit(PLAYERS[0]!, { type: 'startGame' });
    expect(table.state.lastPlay).toBeNull();
  });
});

describe('cards that are down stay down', () => {
  it('refuses to let a player take a card back off the layout', () => {
    const table = started(21);
    const opener = table.state.turn!;
    table.submit(opener, { type: 'move', cardIds: [OPENER], toZone: OPENER_ROW });

    // A row belongs to nobody, which used to mean everybody could reach into it.
    const denied = table.submit(opener, {
      type: 'move',
      cardIds: [OPENER],
      toZone: `hand:${opener}`,
    });
    expect(denied.ok).toBe(false);
    expect(table.state.cards[OPENER]!.zone).toBe(OPENER_ROW);
  });

  it('still lets a player rearrange cards already in their hand', () => {
    const table = started(22);
    const opener = table.state.turn!;
    const hand = [...handOf(table.state, opener)];
    const moved = table.submit(opener, {
      type: 'move',
      cardIds: [hand[4]!],
      toZone: `hand:${opener}`,
      toIndex: 0,
    });
    expect(moved.ok).toBe(true);
    expect(handOf(table.state, opener)[0]).toBe(hand[4]);
  });
});

/**
 * The contract the one-tap play button rests on: see the matching suite in
 * the 7-8 tests. A Sevens card's one destination is the row for its suit.
 */
describe('where a card may go', () => {
  const where = (state: GameState, playerId: PlayerId, cardId: CardId): string[] =>
    sevens.destinationsFor!(state, playerId, cardId);

  it('names the row for the suit, and only for a card that may be played', () => {
    const table = started();
    let checked = 0;

    for (let turn = 0; turn < 60 && table.state.phase === 'playing'; turn++) {
      const actor = table.state.turn;
      if (!actor) break;
      const playable = new Set(legalCards(table.state, actor));

      for (const playerId of table.state.seatOrder) {
        for (const cardId of handOf(table.state, playerId)) {
          const destinations = where(table.state, playerId, cardId);
          if (playerId === actor && playable.has(cardId)) {
            const suit = table.state.cards[cardId]!.face!.suit!;
            expect(destinations).toEqual([rowZoneId(suit)]);
          } else {
            expect(destinations, `${playerId} / ${cardId}`).toEqual([]);
          }
          checked++;
        }
      }

      const next = [...playable][0];
      const result = next
        ? table.submit(actor, { type: 'move', cardIds: [next], toZone: where(table.state, actor, next)[0]! })
        : table.submit(actor, { type: 'passTurn' });
      expect(result.ok, result.ok ? '' : result.reason).toBe(true);
      checked++;
    }

    expect(checked).toBeGreaterThan(200);
  });
});
