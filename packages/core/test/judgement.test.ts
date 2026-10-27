/**
 * जजमेंट.
 *
 * Four things here are new to this engine and all four are worth pinning: a
 * hand that shrinks by a card every round, a trump that comes from the round
 * number rather than from a player, a quota each player sets for themselves
 * and must hit *exactly*, and a pack most of which is thrown away before play
 * begins.
 *
 * The ladder gets the most attention because it is the only part with state
 * carried between deals. Getting it wrong either skips a rung -- so the match
 * ends early with a round never played -- or repeats one, which is the same
 * bug the dealer rotation had in सात-आठ, read off a round count that a redeal
 * does not advance.
 */

import { describe, expect, it } from 'vitest';
import {
  TABLE_INTENTS,
  TAKE,
  TRICK_ZONE,
  Table,
  checkInvariants,
  judgement,
  makeRng,
  projectFor,
  type CardId,
  type GameState,
  type PlayerId,
  type Suit,
} from '../src/index.js';

const PLAYERS = ['ana', 'ben', 'cal', 'dev'];

function table(seed = 1, players = PLAYERS): Table {
  let clock = 1_700_000_000_000;
  const t = new Table({
    roomId: 'judg',
    rulesetId: 'judgement',
    rng: makeRng(seed),
    now: () => clock++,
    strict: true,
  });
  t.create();
  for (const name of players) t.addPlayer(name, name);
  return t;
}

function dealt(seed = 1, players = PLAYERS): Table {
  const t = table(seed, players);
  const started = t.submit(players[0]!, { type: 'startGame' });
  if (!started.ok) throw new Error(started.reason);
  return t;
}

const hand = (state: GameState, playerId: PlayerId): CardId[] =>
  state.zones[`hand:${playerId}`]?.cards ?? [];
const legal = (state: GameState, playerId: PlayerId): CardId[] =>
  judgement.legalCards!(state, playerId);
const handSize = (state: GameState): number => state.gameData['handSize'] as number;
const round = (state: GameState): number => state.gameData['round'] as number;
const stage = (state: GameState): string => state.gameData['stage'] as string;
const suitOf = (state: GameState, cardId: CardId): Suit | null =>
  state.cards[cardId]?.face?.suit ?? null;

/** Say a number of tricks, throwing with the engine's own reason if refused. */
function call(t: Table, playerId: PlayerId, tricks: number): void {
  const said = t.submit(playerId, { type: 'choose', option: `call:${tricks}` });
  if (!said.ok) throw new Error(`${playerId} calling ${tricks}: ${said.reason}`);
}

/**
 * Get the calling over with.
 *
 * Everybody calls nought where they may, and the dealer -- who cannot, if
 * nought is the hooked number -- calls one instead. So the total never equals
 * the hand and the hook never has to be worked around by the caller.
 */
function called(t: Table): Table {
  while (judgement.auction!(t.state)) {
    const auction = judgement.auction!(t.state)!;
    // The lowest rung this player may actually stand on: nought, unless
    // nought is the one the hook has taken away from them.
    const open = auction.stakes.filter((n) => n !== auction.barred?.stake);
    call(t, auction.bidder, open[0]!);
  }
  return t;
}

/** Play the hand out, always the first legal card, taking tricks as they fall. */
function playOut(t: Table, maxPlays = 400): void {
  for (let step = 0; step < maxPlays; step++) {
    if (t.state.phase !== 'playing') return;
    const turn = t.state.turn;
    if (!turn) return;

    const waiting = judgement.awaitingChoice!(t.state);
    if (waiting && t.state.zones[TRICK_ZONE]!.cards.length > 0) {
      const took = t.submit(waiting, { type: 'choose', option: TAKE });
      if (!took.ok) throw new Error(`${waiting} taking the trick: ${took.reason}`);
      continue;
    }

    const playable = legal(t.state, turn);
    if (playable.length === 0) return;
    const played = t.submit(turn, {
      type: 'move',
      cardIds: [playable[0]!],
      toZone: TRICK_ZONE,
      toIndex: t.state.zones[TRICK_ZONE]!.cards.length,
    });
    if (!played.ok) throw new Error(`${turn} playing: ${played.reason}`);
  }
  throw new Error('the hand never ended');
}

/** Deal the next round the way a table does, by agreement. */
function nextRound(t: Table): void {
  const started = t.submit(t.state.seatOrder[0]!, { type: 'startGame' });
  if (!started.ok) throw new Error(started.reason);
}

/** Abandon the hand and deal again, which decides nothing. */
function redeal(t: Table): void {
  const asked = t.submit(t.state.seatOrder[0]!, { type: 'proposeRedeal' });
  if (!asked.ok) throw new Error(asked.reason);
  for (const playerId of [...(t.state.redeal?.waitingOn ?? [])]) {
    const answered = t.submit(playerId, { type: 'answerRedeal', agree: true });
    if (!answered.ok) throw new Error(answered.reason);
  }
}

describe('the ladder', () => {
  it('opens with as many cards as the pack divides into the table', () => {
    // floor(52 / seats), uncapped, so the match length follows the seat count.
    const cases: [string[], number][] = [
      [['ana', 'ben', 'cal'], 17],
      [PLAYERS, 13],
      [['ana', 'ben', 'cal', 'dev', 'eve'], 10],
      [['a', 'b', 'c', 'd', 'e', 'f', 'g'], 7],
      [['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], 5],
    ];

    for (const [players, expected] of cases) {
      const t = dealt(1, players);
      expect(handSize(t.state), `${players.length} seats`).toBe(expected);
      for (const playerId of players) {
        expect(hand(t.state, playerId), `${players.length} seats`).toHaveLength(expected);
      }
      // Down to one card and back up, so the match is twice the opening hand.
      expect(t.state.match.rounds, `${players.length} seats`).toBe(expected * 2);
      expect(checkInvariants(t.state)).toEqual([]);
    }
  });

  it('deals one card fewer every round', () => {
    const t = dealt();
    const sizes = [handSize(t.state)];

    for (let i = 0; i < 3; i++) {
      playOut(called(t));
      nextRound(t);
      sizes.push(handSize(t.state));
    }

    expect(sizes).toEqual([13, 12, 11, 10]);
    expect(round(t.state)).toBe(4);
  });

  /**
   * The bug this engine has had twice.
   *
   * A rung read off `match.played.length` would sit still through a redeal and
   * then skip, because an abandoned hand is never scored. Reading it off the
   * previous *deal* and only advancing it when a hand is actually scored is
   * what makes a redeal replay the same round.
   */
  it('replays the same rung after a redeal, and keeps the dealer', () => {
    const t = dealt();
    const before = { size: handSize(t.state), at: round(t.state), dealer: t.state.gameData['dealer'] };

    for (let i = 0; i < 3; i++) {
      redeal(t);
      expect(handSize(t.state)).toBe(before.size);
      expect(round(t.state)).toBe(before.at);
      expect(t.state.gameData['dealer']).toBe(before.dealer);
    }

    expect(t.state.match.played).toHaveLength(0);
  });

  /**
   * Down to one card and back up again, every rung of it.
   *
   * The single-card hand is dealt twice -- the bottom of the descent and the
   * foot of the climb -- which is what makes the two halves mirror and the
   * match exactly twice the opening hand.
   */
  it('runs the whole ladder out, down to one card and back up', () => {
    const players = ['ana', 'ben', 'cal', 'dev', 'eve'];
    const t = dealt(3, players);
    const sizes: number[] = [];

    for (let i = 0; i < 20; i++) {
      sizes.push(handSize(t.state));
      playOut(called(t));
      if (i < 19) nextRound(t);
    }

    expect(sizes).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(t.state.match.played).toHaveLength(20);
    // Twenty rounds played of a twenty-round match: there is no twenty-first.
    expect(t.state.match.rounds).toBe(20);
  });

  it('deals a full hand again if somebody plays on past the top', () => {
    // Only reachable by dealing after the match is over. The top of the
    // ladder is where it stays, rather than running off the end of the pack.
    const players = ['ana', 'ben', 'cal', 'dev', 'eve'];
    const t = dealt(3, players);
    for (let i = 0; i < 20; i++) {
      playOut(called(t));
      nextRound(t);
    }
    expect(round(t.state)).toBe(21);
    expect(handSize(t.state)).toBe(10);
  });

  /**
   * The largest table the game allows, played right through.
   *
   * Ten seats is five cards each and a five-round match, so the whole ladder
   * fits in one test -- and it is the only size where the trump cycle ends
   * exactly on its trumpless round, which is also the one-card round.
   */
  it('plays a full ten-seat match out, five cards down to one and back', () => {
    const seats = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const t = dealt(1, seats);
    const sizes: number[] = [];
    const trumps: (Suit | null)[] = [];

    for (let r = 1; r <= 10; r += 1) {
      expect(round(t.state), `round ${r}`).toBe(r);
      sizes.push(handSize(t.state));
      trumps.push((t.state.gameData['trump'] as Suit | undefined) ?? null);

      playOut(called(t));
      expect(t.state.phase, `round ${r} did not finish`).toBe('finished');
      expect(checkInvariants(t.state), `round ${r}`).toEqual([]);
      if (r < 10) nextRound(t);
    }

    expect(sizes).toEqual([5, 4, 3, 2, 1, 1, 2, 3, 4, 5]);
    // Ten rounds is two full turns of the five-step trump cycle.
    expect(trumps).toEqual(['S', 'H', 'C', 'D', null, 'S', 'H', 'C', 'D', null]);
    expect(t.state.match.played).toHaveLength(10);
    expect(t.state.match.rounds).toBe(10);
  });

  it('moves the deal one seat to the left each round', () => {
    const t = dealt();
    const seats = t.state.seatOrder;
    let dealer = t.state.gameData['dealer'] as PlayerId;

    for (let i = 0; i < 4; i++) {
      playOut(called(t));
      nextRound(t);
      const expected = seats[(seats.indexOf(dealer) + 1) % seats.length];
      expect(t.state.gameData['dealer'], `round ${i + 2}`).toBe(expected);
      dealer = t.state.gameData['dealer'] as PlayerId;
    }
  });
});

describe('the cards set aside', () => {
  it('do not exist at all', () => {
    // Five seats: ten each is fifty of fifty-two, so two are left over.
    const players = ['ana', 'ben', 'cal', 'dev', 'eve'];
    const t = dealt(1, players);

    expect(Object.keys(t.state.cards)).toHaveLength(10 * 5);
    // Nothing is holding them: there is no stock zone to hold anything.
    expect(t.state.zones['stock']).toBeUndefined();
    const held = players.flatMap((playerId) => hand(t.state, playerId));
    expect(new Set(held).size).toBe(50);
  });

  it('cannot be seen by anybody, because there is nothing to see', () => {
    const players = ['ana', 'ben', 'cal', 'dev', 'eve'];
    const t = dealt(1, players);

    // The strongest form of "out of play": a card that is not in the state
    // cannot be projected to anyone, whatever a visibility rule says.
    for (const viewer of players) {
      const view = projectFor(t.state, viewer);
      expect(Object.keys(view.cards)).toHaveLength(50);
    }
  });

  it('grow as the ladder descends, and are reshuffled each round', () => {
    const t = dealt();
    expect(Object.keys(t.state.cards)).toHaveLength(52); // 13 x 4, none spare

    playOut(called(t));
    nextRound(t);
    // Twelve each is forty-eight, so four sit out this round.
    expect(Object.keys(t.state.cards)).toHaveLength(48);
    expect(checkInvariants(t.state)).toEqual([]);
  });
});

describe('trump, which nobody chooses', () => {
  it('cycles through the four suits and then a round with none', () => {
    const t = dealt();
    const seen: (Suit | null)[] = [];

    for (let i = 0; i < 6; i++) {
      seen.push((t.state.gameData['trump'] as Suit | undefined) ?? null);
      playOut(called(t));
      nextRound(t);
    }

    // Spades, hearts, clubs, diamonds, nothing -- and round again.
    expect(seen).toEqual(['S', 'H', 'C', 'D', null, 'S']);
  });

  it('leaves the fifth round trumpless, and says so', () => {
    const t = dealt();
    for (let i = 0; i < 4; i++) {
      playOut(called(t));
      nextRound(t);
    }

    expect(round(t.state)).toBe(5);
    expect(t.state.gameData['trump']).toBeUndefined();
    // A blank trump strip would read as "not named yet", so the fact is said
    // in words instead.
    expect(judgement.instruction!(called(t).state, PLAYERS[0]!)).toMatch(/no trump/i);
  });

  it('decides a trumpless trick on the led suit alone', () => {
    const t = dealt();
    for (let i = 0; i < 4; i++) {
      playOut(called(t));
      nextRound(t);
    }
    called(t);

    expect(t.state.gameData['trump']).toBeUndefined();
    const size = t.state.inPlay.length;
    const leader = t.state.turn!;
    const led = suitOf(t.state, hand(t.state, leader)[0]!);

    // One trick, no more: everybody plays their first legal card.
    for (let i = 0; i < size; i++) {
      const turn = t.state.turn!;
      t.submit(turn, {
        type: 'move',
        cardIds: [legal(t.state, turn)[0]!],
        toZone: TRICK_ZONE,
        toIndex: i,
      });
    }

    // With no trump, only a card of the led suit can win -- so whoever the
    // engine says won must be holding one, however high anybody else played.
    const winner = judgement.awaitingChoice!(t.state)!;
    expect(winner).not.toBeNull();
    const played = t.state.zones[TRICK_ZONE]!.cards;
    const theirs = played.find((cardId) => t.state.playedBy[cardId] === winner);
    expect(suitOf(t.state, theirs!), 'an off-suit card won a trumpless trick').toBe(led);

    // And it really was the highest of that suit in the trick.
    const ofSuit = played.filter((cardId) => suitOf(t.state, cardId) === led);
    const ranks = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'];
    const strength = (cardId: CardId): number => ranks.indexOf(t.state.cards[cardId]!.face!.rank);
    expect(strength(theirs!)).toBe(Math.min(...ofSuit.map(strength)));
  });
});

describe('the calling', () => {
  it('starts at the dealer\'s left and ends with the dealer', () => {
    const t = dealt();
    const seats = t.state.seatOrder;
    const dealer = t.state.gameData['dealer'] as PlayerId;
    const left = seats[(seats.indexOf(dealer) + 1) % seats.length];

    expect(t.state.inPlay[0]).toBe(left);
    expect(t.state.inPlay.at(-1)).toBe(dealer);
    expect(judgement.auction!(t.state)!.bidder).toBe(left);

    // And it travels round in that order.
    const spoke: PlayerId[] = [];
    while (judgement.auction!(t.state)) {
      const auction = judgement.auction!(t.state)!;
      spoke.push(auction.bidder);
      call(t, auction.bidder, auction.stakes[0]!);
    }
    expect(spoke).toEqual(t.state.inPlay);
  });

  it('lets a player call nothing', () => {
    const t = dealt();
    const first = judgement.auction!(t.state)!.bidder;
    call(t, first, 0);
    expect(t.state.gameData[`bid:${first}`]).toBe(0);
    // Nought is a call, so this player has spoken and the turn has moved on.
    expect(judgement.auction!(t.state)!.bidder).not.toBe(first);
  });

  it('offers no way to pass, because there is none', () => {
    const t = dealt();
    const auction = judgement.auction!(t.state)!;
    expect(auction.passOption).toBeUndefined();
    expect(auction.passLabel).toBeUndefined();
  });

  it('refuses a call out of turn, or bigger than the hand', () => {
    const t = dealt();
    const auction = judgement.auction!(t.state)!;
    const other = t.state.inPlay.find((id) => id !== auction.bidder)!;

    expect(t.submit(other, { type: 'choose', option: 'call:1' })).toMatchObject({ ok: false });
    expect(t.submit(auction.bidder, { type: 'choose', option: 'call:14' })).toMatchObject({
      ok: false,
    });
    expect(t.submit(auction.bidder, { type: 'choose', option: 'call:nonsense' })).toMatchObject({
      ok: false,
    });
  });

  it('plays nothing until everybody has called', () => {
    const t = dealt();
    expect(stage(t.state)).toBe('bidding');
    for (const playerId of t.state.inPlay) expect(legal(t.state, playerId)).toEqual([]);

    called(t);
    expect(stage(t.state)).toBe('playing');
    // The dealer's left called first and leads first.
    expect(t.state.turn).toBe(t.state.inPlay[0]);
    expect(legal(t.state, t.state.inPlay[0]!).length).toBeGreaterThan(0);
  });

  it('takes table business at every stage, calling included', () => {
    const t = dealt();
    const owner = PLAYERS[0]!;
    const samples = TABLE_INTENTS.filter(
      (type) => type !== 'startGame' && type !== 'endMatch',
    ).map((type) =>
      type === 'declare'
        ? ({ type: 'declare', text: 'hm' } as const)
        : type === 'rename'
          ? ({ type: 'rename', name: 'Ana' } as const)
          : type === 'setMatchRounds'
            ? ({ type: 'setMatchRounds', rounds: 3 } as const)
            : type === 'answerRedeal'
              ? ({ type: 'answerRedeal', agree: true } as const)
              : type === 'claimRedeal'
                ? ({ type: 'claimRedeal' } as const)
                : ({ type: 'proposeRedeal' } as const),
    );

    // The list is enumerated rather than written out, so a new table intent
    // fails here until this game has been considered -- which is the point.
    expect([...new Set(samples.map((intent) => intent.type))].sort()).toEqual(
      [...TABLE_INTENTS].filter((type) => type !== 'startGame' && type !== 'endMatch').sort(),
    );

    for (const intent of samples) {
      expect(judgement.validate(t.state, intent, owner), `${intent.type} during the calling`)
        .toMatchObject({ ok: true });
    }
  });
});

describe('the hook', () => {
  it('refuses the dealer the number that would complete the hand', () => {
    const t = dealt();
    const order = [...t.state.inPlay];
    const dealer = order.at(-1)!;

    // Three calls of two: six of thirteen spoken for, so the dealer may not
    // say seven.
    for (const playerId of order.slice(0, -1)) call(t, playerId, 2);

    const auction = judgement.auction!(t.state)!;
    expect(auction.bidder).toBe(dealer);
    expect(auction.barred).toEqual({ stake: 7, note: expect.stringContaining('7') });

    // And the engine refuses it, not merely the panel.
    expect(t.submit(dealer, { type: 'choose', option: 'call:7' })).toMatchObject({ ok: false });
    call(t, dealer, 8);
    expect(stage(t.state)).toBe('playing');
  });

  /**
   * The ladder keeps the hooked number, and names it instead.
   *
   * Cutting it out made the numbers on offer run 0, 2, 3 -- so a player
   * stepping up once from nothing landed on two having asked for one, which
   * is indistinguishable from the wrong call being registered.
   */
  it('leaves the ladder whole and says which rung is barred', () => {
    const t = dealt();
    const order = [...t.state.inPlay];

    // Twelve of thirteen called, so the dealer is hooked off exactly one.
    const calls = [5, 4, 3];
    order.slice(0, -1).forEach((playerId, i) => call(t, playerId, calls[i]!));

    const auction = judgement.auction!(t.state)!;
    expect(auction.barred?.stake).toBe(1);
    // Every number from none to all of them, with no hole in it.
    expect(auction.stakes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    // Which is what makes one step up from nothing mean one.
    expect(auction.stakes[1]).toBe(1);
  });

  it('bars nothing when nobody is hooked', () => {
    const t = dealt();
    expect(judgement.auction!(t.state)!.barred).toBeUndefined();
  });

  it('falls on nobody but the last to speak', () => {
    const t = dealt();
    const order = [...t.state.inPlay];

    // Everybody before the dealer has nothing barred: only the last to speak
    // knows what the total will be.
    for (const playerId of order.slice(0, -1)) {
      const auction = judgement.auction!(t.state)!;
      expect(auction.stakes).toHaveLength(14);
      expect(auction.barred).toBeUndefined();
      call(t, playerId, 2);
    }
    expect(judgement.auction!(t.state)!.barred?.stake).toBe(7);
  });

  it('does not apply when the hand is already over-called', () => {
    const t = dealt();
    const order = [...t.state.inPlay];

    // Three calls of five is fifteen, past the thirteen available, so there is
    // no number the dealer could say that would complete it.
    for (const playerId of order.slice(0, -1)) call(t, playerId, 5);

    const auction = judgement.auction!(t.state)!;
    expect(auction.stakes).toHaveLength(14);
    expect(auction.barred).toBeUndefined();
  });

  it('guarantees somebody fails, whatever is called', () => {
    // The whole purpose of the rule: the calls can never add up to the hand,
    // so they are either over or under and at least one player is wrong.
    for (let seed = 1; seed <= 40; seed++) {
      const t = dealt(seed);
      const rng = makeRng(seed + 500);
      while (judgement.auction!(t.state)) {
        const auction = judgement.auction!(t.state)!;
        // Everything on the ladder except the rung this player is barred
        // from -- which is what the panel offers, and what the engine allows.
        const open = auction.stakes.filter((n) => n !== auction.barred?.stake);
        const pick = open[Math.floor(rng.next() * open.length)]!;
        call(t, auction.bidder, pick);
      }

      const total = t.state.inPlay.reduce(
        (sum, id) => sum + (t.state.gameData[`bid:${id}`] as number),
        0,
      );
      expect(total, `seed ${seed}`).not.toBe(handSize(t.state));
    }
  });
});

describe('what a hand is worth', () => {
  /**
   * Score a finished hand without playing one.
   *
   * The arithmetic is per player and independent, so it is pinned by handing
   * `after` a state with the piles and calls already in it and reading the
   * `gameEnded` body back out -- the same approach लॅडीस uses for its ledger.
   */
  function scoreOf(calls: Record<PlayerId, number>, taken: Record<PlayerId, number>) {
    const t = dealt();
    const seats = [...t.state.inPlay];
    const size = seats.length;

    // A pile of `size` cards is one trick. The cards themselves do not matter
    // to the scoring, only how many tricks each pile holds.
    const state = structuredClone(t.state) as GameState;
    state.gameData['stage'] = 'playing';
    const spare = Object.keys(state.cards);
    let next = 0;
    for (const playerId of seats) {
      state.gameData[`bid:${playerId}`] = calls[playerId] ?? 0;
      const pile = state.zones[`pile:${playerId}`]!;
      for (let i = 0; i < (taken[playerId] ?? 0) * size; i++) {
        const cardId = spare[next++]!;
        pile.cards.push(cardId);
        state.cards[cardId]!.zone = pile.id;
      }
    }
    // Hands empty, trick empty: the hand is finished.
    for (const playerId of seats) state.zones[`hand:${playerId}`]!.cards = [];

    const bodies = judgement.after(state, {
      type: 'cardsMoved',
      placements: [{ cardId: spare[0]!, toZone: `pile:${seats[0]}` }],
      actor: seats[0]!,
    } as never);
    const ended = bodies.find((body) => body.type === 'gameEnded');
    expect(ended, 'the hand did not end').toBeDefined();
    return (ended as { scores: Record<PlayerId, number> }).scores;
  }

  it('pays ten a trick for a call hit exactly', () => {
    const [a, b, c, d] = PLAYERS as [string, string, string, string];
    const scores = scoreOf({ [a]: 3, [b]: 1, [c]: 5, [d]: 2 }, { [a]: 3, [b]: 1, [c]: 5, [d]: 2 });
    expect(scores[a]).toBe(30);
    expect(scores[b]).toBe(10);
    expect(scores[c]).toBe(50);
    expect(scores[d]).toBe(20);
  });

  it('pays five for a called nothing, taken', () => {
    const [a, b] = PLAYERS as [string, string];
    const scores = scoreOf({ [a]: 0 }, { [a]: 0, [b]: 4 });
    expect(scores[a]).toBe(5);
  });

  it('pays nothing for one over and nothing for one under', () => {
    const [a, b, c, d] = PLAYERS as [string, string, string, string];
    const scores = scoreOf({ [a]: 3, [b]: 3, [c]: 0, [d]: 2 }, { [a]: 4, [b]: 2, [c]: 1, [d]: 2 });
    expect(scores[a]).toBe(0); // one over
    expect(scores[b]).toBe(0); // one under
    expect(scores[c]).toBe(0); // called nothing and took one
    expect(scores[d]).toBe(20); // the only one who made it
  });

  it('can score the whole table nothing', () => {
    const [a, b, c, d] = PLAYERS as [string, string, string, string];
    const scores = scoreOf({ [a]: 1, [b]: 1, [c]: 1, [d]: 1 }, { [a]: 0, [b]: 2, [c]: 3, [d]: 4 });
    expect(Object.values(scores)).toEqual([0, 0, 0, 0]);
  });
});

describe('playing a hand', () => {
  it('makes you follow the suit that was led', () => {
    const t = called(dealt());
    const leader = t.state.turn!;
    const lead = hand(t.state, leader)[0]!;
    const led = suitOf(t.state, lead);
    t.submit(leader, { type: 'move', cardIds: [lead], toZone: TRICK_ZONE, toIndex: 0 });

    const next = t.state.turn!;
    const theirs = hand(t.state, next);
    const following = theirs.filter((cardId) => suitOf(t.state, cardId) === led);
    if (following.length === 0) {
      // Nothing of the suit: anything goes, trump included.
      expect(legal(t.state, next).sort()).toEqual([...theirs].sort());
    } else {
      expect(legal(t.state, next).sort()).toEqual([...following].sort());
      const off = theirs.find((cardId) => suitOf(t.state, cardId) !== led);
      if (off) {
        expect(
          t.submit(next, { type: 'move', cardIds: [off], toZone: TRICK_ZONE, toIndex: 1 }),
        ).toMatchObject({ ok: false });
      }
    }
  });

  it('plays exactly as many tricks as there were cards, from any deal', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const t = dealt(seed);
      const size = handSize(t.state);
      playOut(called(t));

      expect(t.state.phase, `seed ${seed}`).toBe('finished');
      const tricks = PLAYERS.reduce(
        (total, playerId) => total + (t.state.zones[`pile:${playerId}`]?.cards.length ?? 0) / 4,
        0,
      );
      expect(tricks, `seed ${seed}`).toBe(size);
      expect(checkInvariants(t.state), `seed ${seed}`).toEqual([]);
    }
  });

  it('hands the lead to whoever won the last trick', () => {
    const t = called(dealt());
    // Play one full trick, then see who leads the next.
    const size = t.state.inPlay.length;
    for (let i = 0; i < size; i++) {
      const turn = t.state.turn!;
      const playable = legal(t.state, turn);
      t.submit(turn, {
        type: 'move',
        cardIds: [playable[0]!],
        toZone: TRICK_ZONE,
        toIndex: i,
      });
    }

    const winner = judgement.awaitingChoice!(t.state)!;
    expect(winner).not.toBeNull();
    t.submit(winner, { type: 'choose', option: TAKE });
    expect(t.state.turn).toBe(winner);
    expect(t.state.zones[`pile:${winner}`]!.cards).toHaveLength(size);
  });

  it('warns the winner when a trick puts them past their call', () => {
    const t = dealt();
    // Everybody calls nothing where they can; whoever wins a trick has
    // already overshot.
    while (judgement.auction!(t.state)) {
      const auction = judgement.auction!(t.state)!;
      call(t, auction.bidder, auction.stakes[0]!);
    }

    const size = t.state.inPlay.length;
    for (let i = 0; i < size; i++) {
      const turn = t.state.turn!;
      t.submit(turn, {
        type: 'move',
        cardIds: [legal(t.state, turn)[0]!],
        toZone: TRICK_ZONE,
        toIndex: i,
      });
    }

    const winner = judgement.awaitingChoice!(t.state)!;
    const offer = judgement.inlineChoice!(t.state, winner)!;
    expect(offer.option).toBe(TAKE);
    const theirCall = t.state.gameData[`bid:${winner}`] as number;
    expect(offer.note).toBe(theirCall === 0 ? 'That puts you past your call' : 'You won that trick');
  });
});

describe('the readout', () => {
  it('shows each call against the tricks taken, and wants them equal', () => {
    const t = called(dealt());
    const rows = judgement.standings!(t.state)!;

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.playerId)).toEqual(t.state.inPlay);
    for (const row of rows) {
      // Hitting the number is the goal, not reaching it: a strip that lit up
      // at "reached" would congratulate a player on having just failed.
      expect(row.exact).toBe(true);
      expect(row.quota).toBe(t.state.gameData[`bid:${row.playerId}`]);
      expect(row.won).toBe(0);
    }
    expect(rows.filter((row) => row.note === 'deals')).toHaveLength(1);
  });

  it('adds the match up with the highest total first', () => {
    const t = dealt();
    playOut(called(t));
    nextRound(t);
    playOut(called(t));

    const board = judgement.scoreboard!(t.state);
    expect(board).toHaveLength(4);
    expect(judgement.scoreDirection).toBe('high');
    for (let i = 1; i < board.length; i++) {
      expect(board[i - 1]!.value).toBeGreaterThanOrEqual(board[i]!.value);
    }
    const total = board.reduce((sum, row) => sum + row.value, 0);
    const fromRounds = t.state.match.played.reduce(
      (sum, played) => sum + Object.values(played.scores).reduce((a, b) => a + b, 0),
      0,
    );
    expect(total).toBe(fromRounds);
  });

  it('says who made their call, or that nobody did', () => {
    const t = dealt();
    playOut(called(t));
    const summary = judgement.roundSummary!(t.state);
    const made = Object.values(t.state.match.played.at(-1)!.scores).filter((v) => v > 0).length;
    expect(summary).toMatch(made === 0 ? /nobody made their call/i : /made their calls?/i);
  });

  it('never asks how long the match should be', () => {
    // The ladder ends at a one-card hand, so there is only one right answer
    // and asking would be asking a question with no alternatives.
    expect(judgement.fixedLength).toBe(true);
    expect(judgement.openEnded).toBeFalsy();
  });
});
