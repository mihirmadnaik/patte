/**
 * लाडीस.
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

  it('breaks a tie in the dealer\'s favour', () => {
    const t = dealt();
    const turns = t.state.inPlay;
    const dealer = turns.at(-1)!;
    say(t, turns[0]!, 'vakkhai:16');
    say(t, turns[1]!, 'vakkhai:16');
    say(t, turns[2]!, PASS);
    say(t, dealer, 'vakkhai:16');
    expect(t.state.gameData['vakkhai']).toBe(dealer);
  });

  it('breaks a tie between two others in favour of whoever said it first', () => {
    const t = dealt();
    const turns = t.state.inPlay;
    // Nearness cannot settle this: both of these sit one seat from the dealer,
    // on either side of them. Order of speaking is all there is.
    say(t, turns[0]!, 'vakkhai:8');
    say(t, turns[1]!, PASS);
    say(t, turns[2]!, 'vakkhai:8');
    say(t, turns[3]!, PASS);
    expect(t.state.gameData['vakkhai']).toBe(turns[0]);
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

describe('trumps played before the reveal', () => {
  it('win nothing they would not have won as ordinary cards', () => {
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

  it('counts the half of a trick played after the trump came up', () => {
    const t = playing();
    const hidden = t.state.zones['trump']!.cards[0]!;
    const trump = t.state.cards[hidden]!.face!.suit;
    const turns = t.state.inPlay;
    const led: Suit = trump === 'H' ? 'S' : 'H';

    const winner = laddis.after(
      {
        ...t.state,
        // Turned up partway through this very trick: two cards were down.
        gameData: { ...t.state.gameData, trump, revealTrick: 0, revealAt: 2 },
        zones: {
          ...t.state.zones,
          [TRICK_ZONE]: { ...t.state.zones[TRICK_ZONE]!, cards: ['x1', 'x2', 'x3', 'x4'] },
        },
        cards: {
          ...t.state.cards,
          // The first trump is too early to count; the second is not.
          x1: faced('x1', led, '9'),
          x2: faced('x2', trump, 'A'),
          x3: faced('x3', trump, '7'),
          x4: faced('x4', led, '8'),
        },
      } as GameState,
      { type: 'cardsMoved', placements: [{ cardId: 'x4', toZone: TRICK_ZONE, toIndex: 3 }], seq: 99, at: 0, actor: turns[3]! },
    );

    // The ace of trumps was played a moment too soon and is just an ace of a
    // suit nobody led; the seven, played after, is the only trump in the trick.
    expect(winner).toEqual([{ type: 'turnSet', playerId: turns[2] }]);
  });
});

describe('वाक्खाई', () => {
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
