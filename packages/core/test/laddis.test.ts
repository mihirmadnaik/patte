/**
 * लॅडीस.
 *
 * Four things here are new to this engine, and all four are worth pinning:
 * sides rather than players, a ledger that settles rather than accumulates, a
 * trump that is a face-down card nobody but its owner may see, and a hand a
 * player can take on alone.
 *
 * The ledger gets the most attention because it is the only one with
 * arithmetic in it. "Posting ten onto the other side" is not addition -- it
 * cancels first -- and the deal follows the result of that cancelling, so
 * getting it wrong moves the deal to the wrong seat and quietly changes whose
 * quota is which for every hand after.
 */

import { describe, expect, it } from 'vitest';
import {
  TABLE_INTENTS,
  TAKE,
  TRICK_ZONE,
  Table,
  checkInvariants,
  laddis,
  makeRng,
  projectFor,
  type CardId,
  type GameState,
  type PlayerId,
  type Suit,
} from '../src/index.js';

const PLAYERS = ['ana', 'ben', 'cal', 'dev'];

const ASK = 'ask';
const PASS = 'pass';

function table(seed = 1, players = PLAYERS): Table {
  let clock = 1_700_000_000_000;
  const t = new Table({
    roomId: 'ladd',
    rulesetId: 'laddis',
    rng: makeRng(seed),
    now: () => clock++,
    strict: true,
  });
  t.create();
  for (const name of players) t.addPlayer(name, name);
  return t;
}

function dealt(seed = 1): Table {
  const t = table(seed);
  const started = t.submit(PLAYERS[0]!, { type: 'startGame' });
  if (!started.ok) throw new Error(started.reason);
  return t;
}

const hand = (state: GameState, playerId: PlayerId): CardId[] =>
  state.zones[`hand:${playerId}`]?.cards ?? [];

const legal = (state: GameState, playerId: PlayerId): CardId[] =>
  laddis.legalCards!(state, playerId);

const stage = (state: GameState): unknown => state.gameData['stage'];

const ledger = (state: GameState): { balance: unknown; owing: unknown } => ({
  balance: state.gameData['balance'],
  owing: state.gameData['owing'],
});

function say(t: Table, playerId: PlayerId, option: string): void {
  const said = t.submit(playerId, { type: 'choose', option });
  if (!said.ok) throw new Error(`${playerId} saying ${option}: ${said.reason}`);
}

/** Everybody passes, so a trump gets set. */
function passRound(t: Table): void {
  for (let i = 0; i < PLAYERS.length; i++) {
    const bidder = laddis.auction!(t.state)?.bidder;
    if (!bidder) break;
    say(t, bidder, PASS);
  }
}

/** Pass the bidding out and set the caller's first card aside as trump. */
function playing(seed = 1): Table {
  const t = dealt(seed);
  passRound(t);
  const caller = t.state.inPlay[0]!;
  const set = t.submit(caller, { type: 'move', cardIds: [hand(t.state, caller)[0]!], toZone: 'trump' });
  if (!set.ok) throw new Error(set.reason);
  return t;
}

/** Play the first legal card for whoever is on turn, taking tricks as they fall. */
function playOut(t: Table, maxPlays = 100): void {
  for (let i = 0; i < maxPlays && t.state.phase === 'playing'; i++) {
    const waiting = laddis.awaitingChoice?.(t.state) ?? null;
    if (waiting) {
      say(t, waiting, TAKE);
      continue;
    }
    const actor = t.state.turn;
    if (!actor) break;
    const options = legal(t.state, actor);
    if (options.length === 0) break;
    const played = t.submit(actor, { type: 'move', cardIds: [options[0]!], toZone: TRICK_ZONE });
    if (!played.ok) throw new Error(`playing: ${played.reason}`);
  }
}

describe('the pack, the sides and the deal', () => {
  it('is thirty-two cards, ace down to seven', () => {
    const t = dealt();
    const ids = Object.keys(t.state.cards);
    expect(ids).toHaveLength(32);
    expect(ids.some((id) => /^[SHDC][2-6]$/.test(id))).toBe(false);
    expect(ids.filter((id) => id.endsWith('7'))).toHaveLength(4);
  });

  it('deals four each and keeps sixteen back', () => {
    const t = dealt();
    for (const playerId of PLAYERS) expect(hand(t.state, playerId)).toHaveLength(4);
    expect(t.state.zones['stock']?.cards).toHaveLength(16);
    expect(checkInvariants(t.state)).toEqual([]);
  });

  it('seats partners opposite each other', () => {
    const t = dealt();
    expect(t.state.teams).toHaveLength(2);
    // Two seats apart in the seating is across the table.
    const [first, second] = t.state.teams;
    expect(first).toEqual(['ana', 'cal']);
    expect(second).toEqual(['ben', 'dev']);
  });

  it('bids and plays from the dealer\'s right, the dealer last', () => {
    const t = dealt();
    const dealer = t.state.gameData['dealer'] as PlayerId;
    expect(t.state.inPlay.at(-1)).toBe(dealer);
    expect(t.state.inPlay[0]).toBe(laddis.auction!(t.state)!.bidder);
  });

  it('hides the undealt half from everybody', () => {
    const t = dealt();
    for (const viewer of PLAYERS) {
      const view = projectFor(t.state, viewer);
      for (const cardId of t.state.zones['stock']?.cards ?? []) {
        expect(view.cards[cardId]?.face, `${cardId} was visible to ${viewer}`).toBeNull();
      }
    }
  });

  it('finishes the deal once the trump is set — seven for the caller, eight for the rest', () => {
    const t = playing();
    const caller = t.state.inPlay[0]!;
    expect(hand(t.state, caller)).toHaveLength(7);
    for (const playerId of PLAYERS.filter((id) => id !== caller)) {
      expect(hand(t.state, playerId)).toHaveLength(8);
    }
    expect(t.state.zones['stock']?.cards).toHaveLength(0);
    expect(t.state.zones['trump']?.cards).toHaveLength(1);
    expect(stage(t.state)).toBe('playing');
    expect(checkInvariants(t.state)).toEqual([]);
  });
});

describe('the auction', () => {
  it('goes round from the dealer\'s right and reaches the trump when all pass', () => {
    const t = dealt();
    const spoken: PlayerId[] = [];
    for (let i = 0; i < 4; i++) {
      const bidder = laddis.auction!(t.state)!.bidder;
      spoken.push(bidder);
      say(t, bidder, PASS);
    }
    expect(spoken).toEqual(t.state.inPlay);
    expect(laddis.auction!(t.state)).toBeNull();
    expect(stage(t.state)).toBe('calling');
  });

  it('refuses a bid from anybody but the player whose call it is', () => {
    const t = dealt();
    const bidder = laddis.auction!(t.state)!.bidder;
    const other = PLAYERS.find((id) => id !== bidder)!;
    expect(t.submit(other, { type: 'choose', option: PASS })).toMatchObject({ ok: false });
  });

  it('offers stakes in eights and refuses anything else', () => {
    const t = dealt();
    const bidder = laddis.auction!(t.state)!.bidder;
    expect(laddis.auction!(t.state)!.stakes).toEqual([8, 16, 24, 32]);
    expect(t.submit(bidder, { type: 'choose', option: 'vakkhai:12' })).toMatchObject({ ok: false });
    // Thirty-two is the ceiling, so the next rung up is not on offer at all.
    expect(t.submit(bidder, { type: 'choose', option: 'vakkhai:40' })).toMatchObject({ ok: false });
  });

  it('will not go below the standing declaration', () => {
    const t = dealt();
    const [first, second] = t.state.inPlay;
    say(t, first!, 'vakkhai:16');
    expect(laddis.auction!(t.state)!.standing).toContain('16');
    expect(laddis.auction!(t.state)!.stakes[0]).toBe(16);
    expect(t.submit(second!, { type: 'choose', option: 'vakkhai:8' })).toMatchObject({ ok: false });
  });

  it('gives the highest stake the hand', () => {
    const t = dealt();
    const [first, second, third, fourth] = t.state.inPlay;
    say(t, first!, 'vakkhai:8');
    say(t, second!, 'vakkhai:24');
    say(t, third!, PASS);
    say(t, fourth!, PASS);
    expect(t.state.gameData['vakkhai']).toBe(second);
    expect(t.state.gameData['stake']).toBe(24);
  });

  it('does not hand a tie to anybody — it asks them again', () => {
    const t = dealt();
    const turns = t.state.inPlay;
    say(t, turns[0]!, 'vakkhai:16');
    say(t, turns[1]!, 'vakkhai:16');
    say(t, turns[2]!, PASS);
    say(t, turns[3]!, PASS);

    // Nobody has the hand yet, and the two who tied are being asked again.
    expect(t.state.gameData['vakkhai']).toBeUndefined();
    expect(stage(t.state)).toBe('bidding');
    expect(laddis.auction!(t.state)!.bidder).toBe(turns[0]);
  });

  it('asks tied opponents to outbid each other', () => {
    const t = dealt();
    const turns = t.state.inPlay;
    // Adjacent seats, so opposite sides: partners sit two apart.
    const [first, second] = turns;
    expect(t.state.teams.some((team) => team.includes(first!) && team.includes(second!))).toBe(false);

    say(t, first!, 'vakkhai:8');
    say(t, second!, 'vakkhai:8');
    say(t, turns[2]!, PASS);
    say(t, turns[3]!, PASS);

    const call = laddis.auction!(t.state)!;
    expect(call.bidder).toBe(first);
    // Holding at the same number is not on offer: they must go higher or go.
    expect(call.stakes).toEqual([16, 24, 32]);
    expect(call.passLabel).toBe('Stand down');

    say(t, first!, 'vakkhai:16');
    say(t, second!, PASS);
    expect(t.state.gameData['vakkhai']).toBe(first);
    expect(t.state.gameData['stake']).toBe(16);
  });

  it('asks tied partners which of them is giving way, at the same stake', () => {
    const t = dealt();
    const turns = t.state.inPlay;
    // Two seats apart, which is across the table: the same side.
    const [first, second, third, fourth] = turns;
    say(t, first!, 'vakkhai:8');
    say(t, second!, PASS);
    say(t, third!, 'vakkhai:8');
    say(t, fourth!, PASS);
    // `first` and `third` are two apart, so they are partners.
    expect(t.state.teams.some((team) => team.includes(first!) && team.includes(third!))).toBe(true);

    const call = laddis.auction!(t.state)!;
    // No outbidding your own partner: the stake is fixed and the only
    // question is who yields.
    expect(call.stakes).toEqual([8]);
    expect(call.passLabel).toBe('Let them have it');

    say(t, first!, 'vakkhai:8');
    say(t, third!, PASS);
    expect(t.state.gameData['vakkhai']).toBe(first);
    expect(t.state.gameData['stake']).toBe(8);
  });

  it('keeps asking partners who both hold', () => {
    const t = dealt();
    const turns = t.state.inPlay;
    const [first, second, third, fourth] = turns;
    say(t, first!, 'vakkhai:8');
    say(t, second!, PASS);
    say(t, third!, 'vakkhai:8');
    say(t, fourth!, PASS);

    // Two rounds of both refusing to budge leaves the hand exactly where it
    // was. That is the rule, not a hang: nothing starts until they settle it.
    for (let round = 0; round < 3; round++) {
      say(t, first!, 'vakkhai:8');
      say(t, third!, 'vakkhai:8');
      expect(t.state.gameData['vakkhai']).toBeUndefined();
      expect(laddis.auction!(t.state)!.bidder).toBe(first);
    }

    say(t, first!, PASS);
    say(t, third!, 'vakkhai:8');
    expect(t.state.gameData['vakkhai']).toBe(third);
  });

  it('gives the ceiling to the side that is not dealing', () => {
    const t = dealt();
    const turns = t.state.inPlay;
    const dealer = turns.at(-1)!;
    const challenger = turns[0]!;
    expect(t.state.teams.some((team) => team.includes(dealer) && team.includes(challenger))).toBe(false);

    say(t, challenger, 'vakkhai:32');
    say(t, turns[1]!, PASS);
    say(t, turns[2]!, PASS);
    say(t, dealer, 'vakkhai:32');

    // Settled on the spot. A run-off asks people to outbid each other, and at
    // the ceiling there is nothing to ask -- so the standing rule decides it
    // rather than putting a question neither of them can answer.
    expect(laddis.auction!(t.state)).toBeNull();
    expect(t.state.gameData['vakkhai']).toBe(challenger);
    expect(t.state.gameData['stake']).toBe(32);
  });

  it('falls back to the bid underneath when everybody in a run-off gives way', () => {
    const t = dealt();
    const turns = t.state.inPlay;
    const [first, second, third, fourth] = turns;
    // A bid cannot go below the standing one, so the eight has to come first.
    say(t, first!, 'vakkhai:8');
    say(t, second!, 'vakkhai:16');
    say(t, third!, 'vakkhai:16');
    say(t, fourth!, PASS);

    // The two at sixteen are opponents and both stand down, so the hand falls
    // to the eight that was bid under them.
    say(t, second!, PASS);
    say(t, third!, PASS);
    expect(t.state.gameData['vakkhai']).toBe(first);
    expect(t.state.gameData['stake']).toBe(8);
  });

  it('reaches the trump call when a run-off empties and nobody else bid', () => {
    const t = dealt();
    const turns = t.state.inPlay;
    say(t, turns[0]!, 'vakkhai:8');
    say(t, turns[1]!, PASS);
    say(t, turns[2]!, 'vakkhai:8');
    say(t, turns[3]!, PASS);
    say(t, turns[0]!, PASS);
    say(t, turns[2]!, PASS);

    expect(t.state.gameData['vakkhai']).toBeUndefined();
    expect(stage(t.state)).toBe('calling');
  });

  it('takes table business at every stage, bidding included', () => {
    const t = dealt();
    const owner = PLAYERS[0]!;
    for (const type of TABLE_INTENTS) {
      if (type === 'startGame' || type === 'endMatch') continue;
      const verdict = laddis.validate(
        t.state,
        type === 'declare'
          ? { type: 'declare', text: 'hm' }
          : type === 'rename'
            ? { type: 'rename', name: 'Ana' }
            : type === 'setMatchRounds'
              ? { type: 'setMatchRounds', rounds: 3 }
              : type === 'answerRedeal'
                ? { type: 'answerRedeal', agree: true }
                : { type: 'proposeRedeal' },
        owner,
      );
      expect(verdict, `${type} during the bidding`).toMatchObject({ ok: true });
    }
  });
});

describe('the hidden trump', () => {
  it('is a card only the caller can see', () => {
    const t = playing();
    const caller = t.state.inPlay[0]!;
    const hidden = t.state.zones['trump']!.cards[0]!;

    expect(projectFor(t.state, caller).cards[hidden]?.face).not.toBeNull();
    for (const viewer of PLAYERS.filter((id) => id !== caller)) {
      expect(projectFor(t.state, viewer).cards[hidden]?.face, `visible to ${viewer}`).toBeNull();
    }
    // And it is nowhere in the public scratchpad either.
    expect(t.state.gameData['trump']).toBeUndefined();
  });

  it('is nobody\'s to take back out again', () => {
    const t = playing();
    const caller = t.state.inPlay[0]!;
    const hidden = t.state.zones['trump']!.cards[0]!;
    expect(
      t.submit(caller, { type: 'move', cardIds: [hidden], toZone: `hand:${caller}` }),
    ).toMatchObject({ ok: false });
  });

  it('can only be asked for by a player on turn who cannot follow', () => {
    const t = playing();
    const leader = t.state.turn!;
    // Nothing has been led, so the leader can always follow their own suit.
    expect(t.submit(leader, { type: 'choose', option: ASK })).toMatchObject({ ok: false });
  });

  it('comes up on request, returns to the caller\'s hand, and becomes public', () => {
    const t = playing(3);
    const caller = t.state.inPlay[0]!;
    const hidden = t.state.zones['trump']!.cards[0]!;
    const suit = t.state.cards[hidden]!.face!.suit;

    // Lead a suit, then find somebody on turn who is void in it.
    let asked = false;
    for (let i = 0; i < 40 && !asked && t.state.phase === 'playing'; i++) {
      const actor = t.state.turn!;
      if (laddis.inlineChoice!(t.state, actor)?.option === ASK) {
        say(t, actor, ASK);
        asked = true;
        break;
      }
      const waiting = laddis.awaitingChoice?.(t.state) ?? null;
      if (waiting) {
        say(t, waiting, TAKE);
        continue;
      }
      const options = legal(t.state, actor);
      if (options.length === 0) break;
      const played = t.submit(actor, { type: 'move', cardIds: [options[0]!], toZone: TRICK_ZONE });
      if (!played.ok) throw new Error(played.reason);
    }

    expect(asked, 'no void hand turned up in this deal').toBe(true);
    expect(t.state.gameData['trump']).toBe(suit);
    expect(t.state.zones['trump']?.cards).toHaveLength(0);
    expect(hand(t.state, caller)).toContain(hidden);
    // Everybody saw it, and goes on knowing which card the caller holds.
    for (const viewer of PLAYERS) {
      expect(projectFor(t.state, viewer).cards[hidden]?.face, `hidden from ${viewer}`).not.toBeNull();
    }
    expect(checkInvariants(t.state)).toEqual([]);
  });

  it('comes back by itself the moment the caller has nothing left to play', () => {
    /*
     * The caller holds seven cards for eight tricks, the eighth being the one
     * they set aside. If nobody has asked for it by then the card has to come
     * back on its own, or the hand would reach a trick the caller cannot play
     * to. Driven directly rather than played towards: a hand often ends early
     * on a quota, and the seeds that happen to run the full eight tricks are
     * not the rule being tested.
     */
    const t = playing();
    const caller = t.state.inPlay[0]!;
    const hidden = t.state.zones['trump']!.cards[0]!;
    const suit = t.state.cards[hidden]!.face!.suit;

    const emptied = {
      ...t.state,
      zones: { ...t.state.zones, [`hand:${caller}`]: { ...t.state.zones[`hand:${caller}`]!, cards: [] } },
    } as GameState;

    const events = laddis.after(emptied, {
      type: 'turnSet',
      playerId: caller,
      seq: 99,
      at: 0,
      actor: caller,
    });

    expect(events).toContainEqual({ type: 'gameDataSet', key: 'trump', value: suit });
    expect(events).toContainEqual({
      type: 'cardsMoved',
      placements: [{ cardId: hidden, toZone: `hand:${caller}`, toIndex: 0 }],
    });
  });

  it('is turned face up for everybody once the hand is over', () => {
    const t = playing();
    playOut(t);
    expect(t.state.phase).toBe('finished');
    const hidden = Object.values(t.state.cards).find((card) => card.zone === 'trump');
    // Either it came back into play, or it is lying face up for all to see.
    if (hidden) expect(hidden.faceUp).toBe(true);
  });

  it('never leaves a hand unplayable, whatever falls', () => {
    // The real property behind the forced reveal: no deal ever gets stuck with
    // somebody on turn and nothing they are allowed to play.
    for (let seed = 1; seed <= 25; seed++) {
      const t = playing(seed);
      playOut(t);
      expect(t.state.phase, `seed ${seed}`).toBe('finished');
      expect(checkInvariants(t.state), `seed ${seed}`).toEqual([]);
    }
  });
});

describe('turning the trump up mid-trick', () => {
  it('leaves a trump-suit card with no special power while the trump is still down', () => {
    const t = playing();
    const caller = t.state.inPlay[0]!;
    const hidden = t.state.zones['trump']!.cards[0]!;
    const trump = t.state.cards[hidden]!.face!.suit;

    // Hand-place a trick: the lead is a heart, and somebody discards a card of
    // the trump suit onto it while the trump is still face down. With the
    // trump down it is a plain discard and cannot win.
    const turns = t.state.inPlay;
    const led: Suit = trump === 'H' ? 'S' : 'H';

    const winner = laddis.after(
      {
        ...t.state,
        gameData: { ...t.state.gameData },
        zones: {
          ...t.state.zones,
          [TRICK_ZONE]: { ...t.state.zones[TRICK_ZONE]!, cards: ['x1', 'x2', 'x3', 'x4'] },
        },
        cards: {
          ...t.state.cards,
          x1: faced('x1', led, '9'),
          x2: faced('x2', led, 'A'),
          x3: faced('x3', trump, 'K'),
          x4: faced('x4', led, '8'),
        },
      } as GameState,
      { type: 'cardsMoved', placements: [{ cardId: 'x4', toZone: TRICK_ZONE, toIndex: 3 }], seq: 99, at: 0, actor: turns[3]! },
    );

    // The ace of the led suit takes it, not the king of the suit that is
    // secretly trump: nobody has turned it up, so it was never a trump.
    expect(winner).toEqual([{ type: 'turnSet', playerId: turns[1] }]);
  });

  it('win once the trump is up', () => {
    const t = playing();
    const hidden = t.state.zones['trump']!.cards[0]!;
    const trump = t.state.cards[hidden]!.face!.suit;
    const turns = t.state.inPlay;
    const led: Suit = trump === 'H' ? 'S' : 'H';

    const winner = laddis.after(
      {
        ...t.state,
        // Turned up before this trick began.
        gameData: { ...t.state.gameData, trump, revealTrick: 0, revealAt: 0 },
        zones: {
          ...t.state.zones,
          [TRICK_ZONE]: { ...t.state.zones[TRICK_ZONE]!, cards: ['x1', 'x2', 'x3', 'x4'] },
        },
        cards: {
          ...t.state.cards,
          x1: faced('x1', led, '9'),
          x2: faced('x2', led, 'A'),
          x3: faced('x3', trump, 'K'),
          x4: faced('x4', led, '8'),
        },
      } as GameState,
      { type: 'cardsMoved', placements: [{ cardId: 'x4', toZone: TRICK_ZONE, toIndex: 3 }], seq: 99, at: 0, actor: turns[3]! },
    );

    expect(winner).toEqual([{ type: 'turnSet', playerId: turns[2] }]);
  });

  it('makes a card already lying in the trick a trump too', () => {
    /*
     * The case this rule exists for. A heart is led, somebody throws the king
     * of spades as a plain discard, the next player cannot follow and calls
     * for the trump -- spades -- and plays the seven.
     *
     * Demoting the king because it was put down a moment too early hands the
     * trick to a seven, which is the wrong answer to look at. Both are
     * spades, so both are trumps, and the king takes it.
     */
    const t = playing();
    const hidden = t.state.zones['trump']!.cards[0]!;
    const trump = t.state.cards[hidden]!.face!.suit;
    const turns = t.state.inPlay;
    const led: Suit = trump === 'H' ? 'S' : 'H';

    const winner = laddis.after(
      {
        ...t.state,
        gameData: { ...t.state.gameData, trump },
        zones: {
          ...t.state.zones,
          [TRICK_ZONE]: { ...t.state.zones[TRICK_ZONE]!, cards: ['x1', 'x2', 'x3', 'x4'] },
        },
        cards: {
          ...t.state.cards,
          x1: faced('x1', led, '9'),
          // Thrown while the trump was still face down.
          x2: faced('x2', trump, 'K'),
          // Thrown after it was turned up.
          x3: faced('x3', trump, '7'),
          x4: faced('x4', led, '8'),
        },
      } as GameState,
      { type: 'cardsMoved', placements: [{ cardId: 'x4', toZone: TRICK_ZONE, toIndex: 3 }], seq: 99, at: 0, actor: turns[3]! },
    );

    expect(winner).toEqual([{ type: 'turnSet', playerId: turns[1] }]);
  });

  it('does not reopen a trick that has already been gathered', () => {
    // Nothing records when the trump came up, because nothing needs to: a
    // finished trick is face down in somebody's pile and is never judged
    // again.
    const t = playing();
    expect(t.state.gameData['revealTrick']).toBeUndefined();
    expect(t.state.gameData['revealAt']).toBeUndefined();
  });
});

describe('वख्खै', () => {
  function alone(seed = 1): { t: Table; declarer: PlayerId; partner: PlayerId } {
    const t = dealt(seed);
    const declarer = t.state.inPlay[0]!;
    say(t, declarer, 'vakkhai:16');
    for (const playerId of t.state.inPlay.slice(1)) say(t, playerId, PASS);
    const partner = t.state.teams.flat().find((id) => id !== declarer && isPartner(t.state, declarer, id))!;
    return { t, declarer, partner };
  }

  function isPartner(state: GameState, a: PlayerId, b: PlayerId): boolean {
    return state.teams.some((team) => team.includes(a) && team.includes(b));
  }

  it('withdraws the partner\'s cards and leaves three players', () => {
    const { t, declarer, partner } = alone();
    expect(hand(t.state, partner)).toHaveLength(0);
    expect(t.state.zones['out']?.cards).toHaveLength(4);
    expect(hand(t.state, declarer)).toHaveLength(4);
    // The stock is never dealt: the hand is the four cards everybody bid on.
    expect(t.state.zones['stock']?.cards).toHaveLength(16);
    expect(t.state.turn).toBe(declarer);
    expect(checkInvariants(t.state)).toEqual([]);
  });

  it('gives the sitting-out partner nothing to do and no way to play', () => {
    const { t, partner } = alone();
    expect(legal(t.state, partner)).toEqual([]);
    expect(laddis.instruction!(t.state, partner)).toContain('sitting this hand out');
  });

  it('is played with no trump at all', () => {
    const { t } = alone();
    expect(t.state.zones['trump']?.cards).toHaveLength(0);
    expect(t.state.gameData['trump']).toBeUndefined();
  });

  it('asks the declarer for every one of the four tricks', () => {
    const { t, declarer } = alone();
    const rows = laddis.standings!(t.state)!;
    expect(rows[0]).toMatchObject({ playerId: declarer, quota: 4, note: 'alone' });
    expect(rows[1]).toMatchObject({ quota: 1 });
  });

  it('pays the other side double the stake when a trick is lost', () => {
    const { t, declarer } = alone();
    playOut(t);
    expect(t.state.phase).toBe('finished');

    const round = t.state.match.played.at(-1)!;
    const opponents = PLAYERS.filter((id) => !isPartner(t.state, declarer, id) && id !== declarer);
    // Either the declarer took all four, or they lost one and pay double.
    const tookAll = round.rankings[0] === declarer || isPartner(t.state, declarer, round.rankings[0]!);
    if (tookAll) {
      expect(round.scores[opponents[0]!]).toBe(16);
    } else {
      expect(round.scores[declarer]).toBe(32);
    }
  });
});

describe('the ledger', () => {
  /** Drive a hand to a known result by handing the ruleset a finished table. */
  function post(
    balance: number,
    owing: PlayerId | '',
    winners: 'dealers' | 'others',
  ): { scores: Record<PlayerId, number>; next: unknown; book: { balance: unknown; owing: unknown } } {
    const t = playing();
    const dealer = t.state.gameData['dealer'] as PlayerId;
    const dealers = t.state.teams.find((team) => team.includes(dealer))!;
    const others = PLAYERS.filter((id) => !dealers.includes(id));
    const taking = winners === 'dealers' ? dealers : others;

    // Hand each winner enough gathered tricks to meet their quota.
    const quota = winners === 'dealers' ? 4 : 5;
    const piles: GameState['zones'] = {};
    const cards: GameState['cards'] = {};
    let n = 0;
    for (const playerId of taking) {
      const ids: CardId[] = [];
      const wanted = playerId === taking[0] ? quota * 4 : 0;
      for (let i = 0; i < wanted; i++) {
        const id = `t${n++}`;
        ids.push(id);
        cards[id] = faced(id, 'S', '9');
      }
      piles[`pile:${playerId}`] = { ...t.state.zones[`pile:${playerId}`]!, cards: ids };
    }

    const state = {
      ...t.state,
      gameData: { ...t.state.gameData, balance, owing },
      zones: { ...t.state.zones, ...piles },
      cards: { ...t.state.cards, ...cards },
    } as GameState;

    const events = laddis.after(state, {
      type: 'cardsMoved',
      placements: [{ cardId: Object.keys(cards)[0]!, toZone: `pile:${taking[0]}`, toIndex: 0 }],
      seq: 99,
      at: 0,
      actor: taking[0]!,
    });

    const ended = events.find((event) => event.type === 'gameEnded');
    const data = Object.fromEntries(
      events.filter((e) => e.type === 'gameDataSet').map((e) => [(e as { key: string }).key, (e as { value: unknown }).value]),
    );
    return {
      scores: (ended as { scores: Record<PlayerId, number> }).scores,
      next: data['nextDealer'],
      book: { balance: data['balance'], owing: data['owing'] },
    };
  }

  it('puts five on the dealers when the other side meets its five', () => {
    const t = playing();
    const dealer = t.state.gameData['dealer'] as PlayerId;
    const { scores, book } = post(0, '', 'others');
    expect(scores[dealer]).toBe(5);
    expect(book.balance).toBe(5);
  });

  it('puts ten on the other side when the dealers meet their four', () => {
    const t = playing();
    const dealer = t.state.gameData['dealer'] as PlayerId;
    const others = PLAYERS.filter((id) => !t.state.teams.find((team) => team.includes(dealer))!.includes(id));
    const { scores } = post(0, '', 'dealers');
    expect(scores[others[0]!]).toBe(10);
    expect(scores[dealer]).toBe(0);
  });

  it('settles against what the dealers were carrying, and hands the deal over', () => {
    const t = playing();
    const dealer = t.state.gameData['dealer'] as PlayerId;
    const dealers = t.state.teams.find((team) => team.includes(dealer))!;
    const others = PLAYERS.filter((id) => !dealers.includes(id));

    // Carrying five and winning posts ten: five of it wipes their own, five
    // crosses over, and with it the deal.
    const { scores, book, next } = post(5, dealer, 'dealers');
    expect(book).toEqual({ balance: 5, owing: others[0] });
    expect(scores[dealer]).toBe(-5);
    expect(scores[others[0]!]).toBe(5);
    expect(others).toContain(next);
  });

  it('lands on nothing at exactly ten, and the same player deals again', () => {
    const t = playing();
    const dealer = t.state.gameData['dealer'] as PlayerId;
    const { book, next, scores } = post(10, dealer, 'dealers');
    expect(book).toEqual({ balance: 0, owing: '' });
    expect(scores[dealer]).toBe(-10);
    expect(next).toBe(dealer);
  });

  it('keeps the deal when a win does not clear the whole debt', () => {
    const t = playing();
    const dealer = t.state.gameData['dealer'] as PlayerId;
    const { book, next } = post(20, dealer, 'dealers');
    expect(book).toEqual({ balance: 10, owing: dealer });
    expect(next).toBe(dealer);
  });

  it('only sinks the dealers deeper when they lose', () => {
    const t = playing();
    const dealer = t.state.gameData['dealer'] as PlayerId;
    const { book, next } = post(5, dealer, 'others');
    expect(book).toEqual({ balance: 10, owing: dealer });
    expect(next).toBe(dealer);
  });

  it('crosses the deal to the partner on passing thirty-two', () => {
    const t = playing();
    const dealer = t.state.gameData['dealer'] as PlayerId;
    const partner = t.state.teams.find((team) => team.includes(dealer))!.find((id) => id !== dealer)!;

    // Twenty-eight and five more is thirty-three: a new band of thirty-two,
    // so the deal crosses the table rather than staying put.
    const { book, next } = post(28, dealer, 'others');
    expect(book).toEqual({ balance: 33, owing: dealer });
    expect(next).toBe(partner);
  });

  it('crosses again at sixty-four', () => {
    const t = playing();
    const dealer = t.state.gameData['dealer'] as PlayerId;
    const partner = t.state.teams.find((team) => team.includes(dealer))!.find((id) => id !== dealer)!;
    const { next } = post(60, dealer, 'others');
    expect(next).toBe(partner);
  });

  it('carries the book and the deal into the next hand', () => {
    const t = playing();
    playOut(t);
    expect(t.state.phase).toBe('finished');

    const before = ledger(t.state);
    const nextDealer = t.state.gameData['nextDealer'];
    const again = t.submit(PLAYERS[0]!, { type: 'startGame' });
    expect(again.ok).toBe(true);
    expect(ledger(t.state)).toEqual(before);
    expect(t.state.gameData['dealer']).toBe(nextDealer);
  });

  it('keeps the deal where it was when a hand is abandoned rather than scored', () => {
    const t = playing();
    const dealer = t.state.gameData['dealer'];
    const owner = PLAYERS[0]!;
    expect(t.submit(owner, { type: 'proposeRedeal' }).ok).toBe(true);
    for (const playerId of [...(t.state.redeal?.waitingOn ?? [])]) {
      expect(t.submit(playerId, { type: 'answerRedeal', agree: true }).ok).toBe(true);
    }
    expect(t.state.gameData['dealer']).toBe(dealer);
    expect(t.state.match.played).toHaveLength(0);
  });

  it('starts the book over for a fresh match', () => {
    const t = playing();
    playOut(t);
    const owner = PLAYERS[0]!;
    expect(t.submit(owner, { type: 'startGame', reset: true }).ok).toBe(true);
    expect(ledger(t.state)).toEqual({ balance: 0, owing: '' });
  });

  it('runs open-ended, so nothing ever declares a last round', () => {
    expect(laddis.openEnded).toBe(true);
  });
});

describe('who played what', () => {
  it('records the player behind every card in the trick', () => {
    const t = playing();
    const played: PlayerId[] = [];
    for (let i = 0; i < 3; i++) {
      const actor = t.state.turn!;
      played.push(actor);
      const options = legal(t.state, actor);
      const moved = t.submit(actor, { type: 'move', cardIds: [options[0]!], toZone: TRICK_ZONE });
      if (!moved.ok) throw new Error(moved.reason);
    }

    const trick = t.state.zones[TRICK_ZONE]!.cards;
    expect(trick).toHaveLength(3);
    expect(trick.map((cardId) => t.state.playedBy[cardId])).toEqual(played);
  });

  it('forgets a card that goes back into a hand', () => {
    // The trump returns to the caller's hand when it is turned up, and a card
    // sitting in somebody's hand is nobody's play.
    const t = playing();
    const caller = t.state.inPlay[0]!;
    const hidden = t.state.zones['trump']!.cards[0]!;
    expect(t.state.playedBy[hidden]).toBe(caller);

    const emptied = {
      ...t.state,
      zones: { ...t.state.zones, [`hand:${caller}`]: { ...t.state.zones[`hand:${caller}`]!, cards: [] } },
    } as GameState;
    for (const body of laddis.after(emptied, { type: 'turnSet', playerId: caller, seq: 9, at: 0, actor: caller })) {
      t.commit(caller, [body]);
    }

    expect(t.state.zones[`hand:${caller}`]?.cards).toContain(hidden);
    expect(t.state.playedBy[hidden]).toBeUndefined();
  });

  it('starts every deal with a clean slate', () => {
    const t = playing();
    playOut(t);
    expect(Object.keys(t.state.playedBy).length).toBeGreaterThan(0);
    expect(t.submit(PLAYERS[0]!, { type: 'startGame' }).ok).toBe(true);
    expect(t.state.playedBy).toEqual({});
  });
});

describe('turning the trump up', () => {
  it('announces the suit and holds the card itself up', () => {
    const t = playing();
    const hidden = t.state.zones['trump']!.cards[0]!;
    const suit = t.state.cards[hidden]!.face!.suit;

    const revealed = {
      ...t.state,
      gameData: { ...t.state.gameData, trump: suit, trumpCard: hidden },
    } as GameState;

    const said = laddis.announce!(
      revealed,
      { type: 'gameDataSet', key: 'trump', value: suit, seq: 9, at: 0, actor: PLAYERS[1]! },
      PLAYERS[0]!,
    );

    expect(said).toMatchObject({ show: [hidden] });
    expect(typeof said === 'object' && said?.line).toContain('Trump is up');
  });

  it('tells the player who asked for it as well', () => {
    // They have not seen the card either -- they only know it is down.
    const t = playing();
    const hidden = t.state.zones['trump']!.cards[0]!;
    const suit = t.state.cards[hidden]!.face!.suit;
    const asker = PLAYERS[1]!;
    const revealed = {
      ...t.state,
      gameData: { ...t.state.gameData, trump: suit, trumpCard: hidden },
    } as GameState;

    expect(
      laddis.announce!(
        revealed,
        { type: 'gameDataSet', key: 'trump', value: suit, seq: 9, at: 0, actor: asker },
        asker,
      ),
    ).not.toBeNull();
  });

  it('keeps the card out of the public scratchpad while it is down', () => {
    const t = playing();
    expect(t.state.gameData['trumpCard']).toBeUndefined();
    expect(t.state.gameData['trump']).toBeUndefined();
  });
});

describe('four sevens', () => {
  /** Put every seven in one player's hand, leaving the counts honest. */
  function dealtFourSevens(playerId: PlayerId): Table {
    const t = dealt();
    const sevens = Object.values(t.state.cards).filter((card) => card.face?.rank === '7').map((c) => c.id);
    expect(sevens).toHaveLength(4);

    const zones = structuredClone(t.state.zones);
    const cards = structuredClone(t.state.cards);
    // Everything the player held that is not a seven goes back to the stock,
    // and every seven comes to them, so no card is in two places at once.
    const mine = zones[`hand:${playerId}`]!;
    const stock = zones['stock']!;
    const spare = mine.cards.filter((id) => !sevens.includes(id));
    for (const zone of Object.values(zones)) zone.cards = zone.cards.filter((id) => !sevens.includes(id));
    mine.cards = [...sevens];
    stock.cards = [...stock.cards.filter((id) => !spare.includes(id)), ...spare];
    for (const id of sevens) cards[id]!.zone = mine.id;
    for (const id of spare) cards[id]!.zone = stock.id;

    t.state = { ...t.state, zones, cards };
    expect(checkInvariants(t.state)).toEqual([]);
    return t;
  }

  it('offers a fresh deal to whoever holds them all', () => {
    const t = dealtFourSevens('ana');
    expect(laddis.redealClaim!(t.state, 'ana')?.prompt).toBe('You have four 7s, would you like to redeal?');
    for (const other of PLAYERS.filter((id) => id !== 'ana')) {
      expect(laddis.redealClaim!(t.state, other), other).toBeNull();
    }
  });

  it('deals again, says so, and leaves the scores alone', () => {
    const t = dealtFourSevens('ana');
    const before = t.state.match.played.length;
    const dealer = t.state.gameData['dealer'];

    const claimed = t.submit('ana', { type: 'claimRedeal' });
    expect(claimed.ok).toBe(true);

    // Everybody is told why their hand went away.
    expect(t.state.declarations.at(-1)?.text).toContain('four 7s');
    expect(t.state.declarations.at(-1)?.by).toBe('ana');

    // A fresh hand, the same dealer, and nothing scored.
    expect(t.state.phase).toBe('playing');
    expect(stage(t.state)).toBe('bidding');
    expect(t.state.match.played).toHaveLength(before);
    expect(t.state.gameData['dealer']).toBe(dealer);
    expect(hand(t.state, 'ana')).toHaveLength(4);
    expect(checkInvariants(t.state)).toEqual([]);
  });

  it('carries the ledger across the fresh deal', () => {
    const t = dealtFourSevens('ana');
    t.commit(null, [
      { type: 'gameDataSet', key: 'balance', value: 15 },
      { type: 'gameDataSet', key: 'owing', value: 'ana' },
    ]);
    expect(t.submit('ana', { type: 'claimRedeal' }).ok).toBe(true);
    expect(ledger(t.state)).toEqual({ balance: 15, owing: 'ana' });
  });

  it('refuses the claim from anybody who does not hold them', () => {
    const t = dealtFourSevens('ana');
    expect(t.submit('ben', { type: 'claimRedeal' })).toMatchObject({ ok: false });
  });

  it('is off the table once a card has been played', () => {
    const t = dealtFourSevens('ana');
    // Pass the bidding out, set a trump, and lead -- by which point the hand
    // is under way and the offer has gone.
    passRound(t);
    const caller = t.state.inPlay[0]!;
    t.submit(caller, { type: 'move', cardIds: [hand(t.state, caller)[0]!], toZone: 'trump' });
    const leader = t.state.turn!;
    t.submit(leader, { type: 'move', cardIds: [legal(t.state, leader)[0]!], toZone: TRICK_ZONE });

    expect(laddis.redealClaim!(t.state, 'ana')).toBeNull();
    expect(t.submit('ana', { type: 'claimRedeal' })).toMatchObject({ ok: false });
  });

  it('is still open after the second half of the deal', () => {
    // The four can arrive split across the two halves, so the offer is made
    // whenever it becomes true rather than once at the start.
    const t = dealt();
    passRound(t);
    const caller = t.state.inPlay[0]!;
    t.submit(caller, { type: 'move', cardIds: [hand(t.state, caller)[0]!], toZone: 'trump' });
    expect(stage(t.state)).toBe('playing');

    const holder = PLAYERS.find((id) => id !== caller)!;
    const sevens = Object.values(t.state.cards).filter((c) => c.face?.rank === '7').map((c) => c.id);
    const zones = structuredClone(t.state.zones);
    const cards = structuredClone(t.state.cards);
    const mine = zones[`hand:${holder}`]!;
    const spare = mine.cards.filter((id) => !sevens.includes(id)).slice(0, sevens.length);
    for (const zone of Object.values(zones)) zone.cards = zone.cards.filter((id) => !sevens.includes(id));
    mine.cards = [...mine.cards.filter((id) => !spare.includes(id)), ...sevens];
    for (const id of sevens) cards[id]!.zone = mine.id;
    // The cards they gave up go to whoever the sevens came from, so the
    // table still holds exactly thirty-two.
    const elsewhere = zones[`hand:${caller}`]!;
    elsewhere.cards = [...elsewhere.cards, ...spare];
    for (const id of spare) cards[id]!.zone = elsewhere.id;
    t.state = { ...t.state, zones, cards };

    expect(checkInvariants(t.state)).toEqual([]);
    expect(laddis.redealClaim!(t.state, holder)).not.toBeNull();
  });
});

describe('the standings strip', () => {
  it('shows two sides, the dealing one first', () => {
    const t = playing();
    const dealer = t.state.gameData['dealer'] as PlayerId;
    const rows = laddis.standings!(t.state)!;

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ quota: 4, note: 'deals' });
    expect(rows[0]!.team).toContain(dealer);
    expect(rows[1]).toMatchObject({ quota: 5 });
    expect(rows[1]!.team).not.toContain(dealer);
  });

  it('names a side in the same order whoever is dealing', () => {
    // `inPlay` rotates with the deal, so a side read off it is named one way
    // in one hand and the other way in the next -- which looks like the sides
    // themselves changed.
    const t = playing();
    const sides = (state: GameState): string[] =>
      (laddis.standings!(state) ?? []).map((row) => [...(row.team ?? [])].join('+')).sort();

    const first = sides(t.state);
    // Same table, deal rotated by one seat.
    const rotated = { ...t.state, inPlay: [...t.state.inPlay.slice(1), t.state.inPlay[0]!] } as GameState;
    expect(sides({ ...rotated, gameData: { ...rotated.gameData, dealer: rotated.inPlay.at(-1)! } })).toEqual(first);
  });
});

describe('a hand played out', () => {
  it('ends the moment a side meets its quota, with cards still unplayed', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const t = playing(seed);
      playOut(t);
      expect(t.state.phase, `seed ${seed}`).toBe('finished');

      const round = t.state.match.played.at(-1)!;
      // Exactly one side is posted onto, and the two sides' numbers cancel.
      const values = Object.values(round.scores);
      expect(values.filter((value) => value > 0).length).toBeGreaterThan(0);
      expect(checkInvariants(t.state)).toEqual([]);
    }
  });

  it('is the same state when the log is replayed from empty', () => {
    const t = playing(4);
    playOut(t);
    expect(t.replay()).toEqual(t.state);
  });

  it('never lets a side get past its quota by more than the last trick', () => {
    const t = playing(2);
    playOut(t);
    const rows = laddis.standings!(t.state) ?? [];
    for (const row of rows) expect(row.won).toBeLessThanOrEqual(row.quota);
  });
});

/** A card with a face, for tests that place a trick by hand. */
function faced(id: CardId, suit: Suit, rank: string): GameState['cards'][string] {
  return {
    id,
    face: { suit, rank: rank as 'A' },
    zone: TRICK_ZONE,
    faceUp: true,
    revealedTo: [],
    heldBy: null,
    version: 0,
  };
}
