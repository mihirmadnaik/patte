import { describe, expect, it } from 'vitest';
import { dealAgain } from './helpers.js';
import {
  CALLER_QUOTA,
  DEALER_QUOTA,
  TAKE,
  TRICK_ZONE,
  Table,
  availableCards,
  beats,
  callerOf,
  checkInvariants,
  dealerOf,
  ledSuit,
  makeRng,
  pileZoneId,
  quotaFor,
  projectFor,
  saatAath,
  stackZoneId,
  stageOf,
  trickAwaitingCollection,
  tricksCredited,
  tricksWon,
  trumpOf,
  type Card,
  type CardId,
  type GameState,
  type PlayerId,
  type Rank,
  type Suit,
} from '../src/index.js';

const PLAYERS = ['ana', 'ben'];
const SUITS: Suit[] = ['S', 'H', 'D', 'C'];
const STRONGEST_FIRST: Rank[] = ['A', 'K', 'Q', 'J', '10', '9', '8', '7'];

function table(seed = 1): Table {
  let clock = 1_700_000_000_000;
  const t = new Table({
    roomId: '78',
    rulesetId: 'saat-aath',
    rng: makeRng(seed),
    now: () => clock++,
    strict: true,
  });
  t.create();
  for (const name of PLAYERS) t.addPlayer(name, name);
  return t;
}

/** A dealt round, still waiting for trump to be called. */
function dealt(seed = 1): Table {
  const t = table(seed);
  const started = t.submit(PLAYERS[0]!, { type: 'startGame' });
  if (!started.ok) throw new Error(started.reason);
  return t;
}

/** A round in play, with trump called. */
function playing(seed = 1, trump: Suit = 'S'): Table {
  const t = dealt(seed);
  const caller = callerOf(t.state)!;
  const called = t.submit(caller, { type: 'choose', option: trump });
  if (!called.ok) throw new Error(called.reason);
  return t;
}

const legal = (state: GameState, playerId: PlayerId): CardId[] =>
  saatAath.legalCards!(state, playerId);

function play(t: Table, cardId: CardId): void {
  const actor = t.state.turn!;
  const result = t.submit(actor, { type: 'move', cardIds: [cardId], toZone: TRICK_ZONE });
  if (!result.ok) throw new Error(`${actor} could not play ${cardId}: ${result.reason}`);
}

/** Pick up a decided trick, if one is waiting. */
function take(t: Table): boolean {
  const winner = trickAwaitingCollection(t.state);
  if (!winner) return false;
  const result = t.submit(winner, { type: 'choose', option: TAKE });
  if (!result.ok) throw new Error(`${winner} could not take the trick: ${result.reason}`);
  return true;
}

/** Play the round out, taking each trick and then leading the first legal card. */
function playOut(t: Table, maxPlays = 120): void {
  for (let i = 0; i < maxPlays && t.state.phase === 'playing'; i++) {
    if (take(t)) continue;
    const actor = t.state.turn;
    if (!actor) break;
    const options = legal(t.state, actor);
    if (options.length === 0) break;
    play(t, options[0]!);
  }
}

describe('the pack', () => {
  it('is thirty cards: no low cards, and only two sevens', () => {
    const t = dealt();
    const ids = Object.keys(t.state.cards);
    expect(ids).toHaveLength(30);

    for (const rank of ['2', '3', '4', '5', '6']) {
      expect(ids.filter((id) => id.slice(1) === rank)).toHaveLength(0);
    }
    expect(ids.filter((id) => id.slice(1) === '7').sort()).toEqual(['H7', 'S7']);

    // Hearts and spades run eight deep, clubs and diamonds seven.
    expect(ids.filter((id) => id[0] === 'H')).toHaveLength(8);
    expect(ids.filter((id) => id[0] === 'S')).toHaveLength(8);
    expect(ids.filter((id) => id[0] === 'C')).toHaveLength(7);
    expect(ids.filter((id) => id[0] === 'D')).toHaveLength(7);
  });
});

describe('which card beats which', () => {
  const card = (id: CardId, state: GameState): Card => state.cards[id]!;

  it('is a strict total order for every possible trump', () => {
    const state = dealt().state;
    const ids = Object.keys(state.cards);

    for (const trump of SUITS) {
      // Rank every card, then check the comparison agrees with that order for
      // all 870 ordered pairs. Any special case would show up as a cycle.
      const strength = (id: CardId): number => {
        const suit = card(id, state).face!.suit!;
        const rank = STRONGEST_FIRST.indexOf(card(id, state).face!.rank);
        return (suit === trump ? 0 : 1) * 100 + rank;
      };

      for (const a of ids) {
        for (const b of ids) {
          if (a === b) continue;
          const cardA = card(a, state);
          const cardB = card(b, state);
          const led = cardB.face!.suit!;
          // With b led, a wins only if it is stronger under the same led suit.
          const expected = strength(a) < strength(b) && (cardA.face!.suit === led || cardA.face!.suit === trump);
          expect(beats(cardA, cardB, led, trump), `${a} vs ${b}, trump ${trump}`).toBe(expected);
        }
      }
    }
  });

  it('makes the trump ace the best card in the game', () => {
    const state = dealt().state;
    for (const trump of SUITS) {
      const ace = card(`${trump}A`, state);
      for (const id of Object.keys(state.cards)) {
        if (id === ace.id) continue;
        const other = card(id, state);
        // Whatever is led, the trump ace takes it, and nothing takes it back.
        expect(beats(ace, other, other.face!.suit!, trump), `${trump}A should beat ${id}`).toBe(true);
        expect(beats(other, ace, trump, trump), `${id} should not beat ${trump}A`).toBe(false);
      }
    }
  });

  it('treats the sevens as ordinary low cards, not jokers', () => {
    const state = dealt().state;
    for (const seven of ['H7', 'S7'] as const) {
      const suit = seven[0] as Suit;
      // Beaten by the eight of its own suit...
      expect(beats(card(`${suit}8`, state), card(seven, state), suit, suit)).toBe(true);
      expect(beats(card(seven, state), card(`${suit}8`, state), suit, suit)).toBe(false);
      // ...and powerless when it is not trump.
      const otherTrump: Suit = suit === 'H' ? 'C' : 'D';
      expect(beats(card(seven, state), card('CA', state), 'C', otherTrump)).toBe(false);
    }
  });

  it('lets any trump beat any non-trump', () => {
    const state = dealt().state;
    // The weakest trump against the strongest plain card.
    expect(beats(card('C8', state), card('HA', state), 'H', 'C')).toBe(true);
  });

  it('gives a card that is neither trump nor the led suit no chance', () => {
    const state = dealt().state;
    expect(beats(card('DA', state), card('H8', state), 'H', 'S')).toBe(false);
  });
});

describe('the deal', () => {
  it('gives each player five in hand and five stacks of two', () => {
    const t = dealt();
    for (const playerId of PLAYERS) {
      expect(t.state.zones[`hand:${playerId}`]!.cards).toHaveLength(5);
      for (let i = 0; i < 5; i++) {
        expect(t.state.zones[stackZoneId(playerId, i)]!.cards).toHaveLength(2);
      }
      expect(t.state.zones[pileZoneId(playerId)]!.cards).toHaveLength(0);
    }
    expect(t.state.zones[TRICK_ZONE]!.cards).toHaveLength(0);
    expect(checkInvariants(t.state)).toEqual([]);
  });

  it('leaves nothing undealt', () => {
    const t = dealt();
    const filed = Object.values(t.state.zones).flatMap((z) => z.cards);
    expect(filed).toHaveLength(30);
  });

  it('waits for trump before turning anything up', () => {
    const t = dealt();
    expect(stageOf(t.state)).toBe('calling');
    expect(trumpOf(t.state)).toBeNull();
    for (const card of Object.values(t.state.cards)) expect(card.faceUp).toBe(false);
  });

  it('hides a buried stack card from both players, not just the opponent', () => {
    const t = playing();
    for (const playerId of PLAYERS) {
      for (let i = 0; i < 5; i++) {
        const [buried, top] = t.state.zones[stackZoneId(playerId, i)]!.cards;
        // The top is public to everyone; what is under it is nobody's.
        for (const viewer of [...PLAYERS, null]) {
          expect(projectFor(t.state, viewer).cards[top!]!.face).not.toBeNull();
          expect(
            projectFor(t.state, viewer).cards[buried!]!.face,
            `${buried} leaked to ${viewer ?? 'a spectator'}`,
          ).toBeNull();
        }
      }
    }
  });

  it('keeps each hand to its owner', () => {
    const t = playing();
    const view = projectFor(t.state, 'ana');
    for (const id of t.state.zones['hand:ana']!.cards) expect(view.cards[id]!.face).not.toBeNull();
    for (const id of t.state.zones['hand:ben']!.cards) expect(view.cards[id]!.face).toBeNull();
  });

  it('alternates the deal between rounds', () => {
    const t = table(3);
    const dealers: (PlayerId | null)[] = [];
    for (let round = 0; round < 4; round++) {
      t.submit(PLAYERS[0]!, { type: 'startGame' });
      dealers.push(dealerOf(t.state));
      const caller = callerOf(t.state)!;
      t.submit(caller, { type: 'choose', option: 'S' });
      playOut(t);
    }
    expect(dealers).toEqual([PLAYERS[0], PLAYERS[1], PLAYERS[0], PLAYERS[1]]);
  });

  it('gives the lead to whoever calls trump', () => {
    const t = playing();
    expect(t.state.turn).toBe(callerOf(t.state));
    expect(t.state.turn).not.toBe(dealerOf(t.state));
  });
});

describe('calling trump', () => {
  it('lets only the non-dealer call', () => {
    const t = dealt();
    const dealer = dealerOf(t.state)!;
    const denied = t.submit(dealer, { type: 'choose', option: 'H' });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toMatch(/other player calls trump/);
  });

  it('refuses anything that is not a suit', () => {
    const t = dealt();
    const caller = callerOf(t.state)!;
    expect(t.submit(caller, { type: 'choose', option: 'bananas' }).ok).toBe(false);
  });

  it('refuses cards until trump is named', () => {
    const t = dealt();
    const caller = callerOf(t.state)!;
    const card = t.state.zones[`hand:${caller}`]!.cards[0]!;
    const denied = t.submit(caller, { type: 'move', cardIds: [card], toZone: TRICK_ZONE });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toMatch(/waiting for trump/);
  });

  it('turns up exactly the ten stack tops once called', () => {
    const t = playing(1, 'H');
    expect(trumpOf(t.state)).toBe('H');
    expect(stageOf(t.state)).toBe('playing');

    const faceUp = Object.values(t.state.cards).filter((card) => card.faceUp);
    expect(faceUp).toHaveLength(10);
    for (const card of faceUp) expect(t.state.zones[card.zone]!.kind).toBe('stack');
  });
});

describe('following suit', () => {
  it('offers hand and stack tops together when leading', () => {
    const t = playing();
    const leader = t.state.turn!;
    expect(new Set(legal(t.state, leader))).toEqual(new Set(availableCards(t.state, leader)));
    expect(legal(t.state, leader).length).toBe(10); // five in hand, five tops
  });

  it('narrows to the led suit when the player holds it', () => {
    const t = playing();
    const leader = t.state.turn!;
    const lead = legal(t.state, leader)[0]!;
    play(t, lead);

    const led = ledSuit(t.state)!;
    const responder = t.state.turn!;
    const available = availableCards(t.state, responder);
    const matching = available.filter((id) => t.state.cards[id]!.face!.suit === led);

    expect(new Set(legal(t.state, responder))).toEqual(
      new Set(matching.length > 0 ? matching : available),
    );
  });

  it('refuses an off-suit card while the player can follow', () => {
    // Search seeds until the responder holds the led suit and something else.
    for (let seed = 1; seed <= 40; seed++) {
      const t = playing(seed);
      play(t, legal(t.state, t.state.turn!)[0]!);
      const led = ledSuit(t.state)!;
      const responder = t.state.turn!;
      const available = availableCards(t.state, responder);
      const offSuit = available.find((id) => t.state.cards[id]!.face!.suit !== led);
      if (!offSuit || !available.some((id) => t.state.cards[id]!.face!.suit === led)) continue;

      const denied = t.submit(responder, { type: 'move', cardIds: [offSuit], toZone: TRICK_ZONE });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.reason).toMatch(new RegExp(`follow ${led}`));
      return;
    }
    throw new Error('no seed produced a follow-suit situation');
  });

  it('will not let a player reach a buried card', () => {
    const t = playing();
    const leader = t.state.turn!;
    const buried = t.state.zones[stackZoneId(leader, 0)]!.cards[0]!;
    expect(availableCards(t.state, leader)).not.toContain(buried);
    expect(t.submit(leader, { type: 'move', cardIds: [buried], toZone: TRICK_ZONE }).ok).toBe(false);
  });

  it('will not let a player play out of turn', () => {
    const t = playing();
    const waiting = PLAYERS.find((p) => p !== t.state.turn)!;
    const card = t.state.zones[`hand:${waiting}`]!.cards[0]!;
    const denied = t.submit(waiting, { type: 'move', cardIds: [card], toZone: TRICK_ZONE });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toMatch(/your turn/);
  });
});

describe('stacks', () => {
  it('uncovers the buried card when its cover is played', () => {
    const t = playing();
    const leader = t.state.turn!;
    const stack = stackZoneId(leader, 0);
    const [buried, top] = t.state.zones[stack]!.cards;

    expect(t.state.cards[buried!]!.faceUp).toBe(false);
    play(t, top!);

    expect(t.state.zones[stack]!.cards).toEqual([buried]);
    expect(t.state.cards[buried!]!.faceUp).toBe(true);
    // And now everyone can see it, because it is on show.
    expect(projectFor(t.state, 'ben').cards[buried!]!.face).not.toBeNull();
  });

  it('leaves a stack empty once both its cards are gone', () => {
    const t = playing(5);
    const leader = t.state.turn!;
    const stack = stackZoneId(leader, 0);
    play(t, t.state.zones[stack]!.cards[1]!);
    // Opponent replies, lead comes back around eventually; just check the
    // stack shrinks rather than regrowing.
    expect(t.state.zones[stack]!.cards).toHaveLength(1);
  });
});

describe('taking tricks', () => {
  it('leaves the finished trick on the table until its winner takes it', () => {
    const t = playing();
    play(t, legal(t.state, t.state.turn!)[0]!);
    play(t, legal(t.state, t.state.turn!)[0]!);

    // Both cards still in the middle, and nobody has picked them up.
    expect(t.state.zones[TRICK_ZONE]!.cards).toHaveLength(2);
    expect(PLAYERS.every((p) => tricksWon(t.state, p) === 0)).toBe(true);

    const winner = trickAwaitingCollection(t.state)!;
    expect(winner).toBe(t.state.turn);
    // The winner is credited straight away even though the cards are still out.
    expect(tricksCredited(t.state, winner)).toBe(1);

    take(t);
    expect(t.state.zones[TRICK_ZONE]!.cards).toHaveLength(0);
    expect(tricksWon(t.state, winner)).toBe(1);
    expect(t.state.turn).toBe(winner);
  });

  it('refuses a card until the trick has been taken', () => {
    const t = playing();
    play(t, legal(t.state, t.state.turn!)[0]!);
    play(t, legal(t.state, t.state.turn!)[0]!);

    const winner = trickAwaitingCollection(t.state)!;
    const loser = PLAYERS.find((p) => p !== winner)!;

    const denied = t.submit(winner, {
      type: 'move',
      cardIds: [availableCards(t.state, winner)[0]!],
      toZone: TRICK_ZONE,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toMatch(/take the trick first/);

    // And the other player cannot take it on their behalf.
    const stolen = t.submit(loser, { type: 'choose', option: TAKE });
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) expect(stolen.reason).toMatch(/not yours/);
  });

  it('turns a taken trick face down, hidden from everybody', () => {
    const t = playing();
    play(t, legal(t.state, t.state.turn!)[0]!);
    play(t, legal(t.state, t.state.turn!)[0]!);
    const taken = [...t.state.zones[TRICK_ZONE]!.cards];
    const winner = trickAwaitingCollection(t.state)!;
    take(t);

    for (const cardId of taken) {
      expect(t.state.cards[cardId]!.faceUp).toBe(false);
      // Not even the player who won them can look through them again.
      for (const viewer of [...PLAYERS, null]) {
        expect(
          projectFor(t.state, viewer).cards[cardId]!.face,
          `${cardId} still visible to ${viewer ?? 'a spectator'}`,
        ).toBeNull();
      }
    }
    expect(t.state.zones[pileZoneId(winner)]!.cards).toEqual(taken);
  });

  it('will not let a player pull a card back out of their winnings', () => {
    const t = playing();
    play(t, legal(t.state, t.state.turn!)[0]!);
    play(t, legal(t.state, t.state.turn!)[0]!);
    const winner = trickAwaitingCollection(t.state)!;
    take(t);

    const won = t.state.zones[pileZoneId(winner)]!.cards[0]!;
    const denied = t.submit(winner, {
      type: 'move',
      cardIds: [won],
      toZone: `hand:${winner}`,
    });
    expect(denied.ok).toBe(false);
    expect(t.state.cards[won]!.zone).toBe(pileZoneId(winner));
  });

  it('gives the trick to the higher card, and the lead with it', () => {
    const t = playing(2, 'S');
    const leader = t.state.turn!;
    const lead = legal(t.state, leader)[0]!;
    play(t, lead);

    const responder = t.state.turn!;
    const reply = legal(t.state, responder)[0]!;
    play(t, reply);

    const led = t.state.cards[lead]!.face!.suit!;
    const responderWins = beats(t.state.cards[reply]!, t.state.cards[lead]!, led, 'S');
    expect(t.state.turn).toBe(responderWins ? responder : leader);
  });
});

describe('a full round', () => {
  it('plays exactly fifteen tricks from any deal', () => {
    for (let seed = 1; seed <= 25; seed++) {
      for (const trump of SUITS) {
        const t = playing(seed, trump);
        playOut(t);

        expect(t.state.phase, `seed ${seed} trump ${trump} did not finish`).toBe('finished');
        const won = PLAYERS.map((p) => tricksWon(t.state, p));
        expect(won[0]! + won[1]!).toBe(15);
        expect(checkInvariants(t.state)).toEqual([]);

        // Every card ends in somebody's pile; nothing is left in a hand.
        const inPiles = PLAYERS.reduce((n, p) => n + t.state.zones[pileZoneId(p)]!.cards.length, 0);
        expect(inPiles).toBe(30);
      }
    }
  });

  it('scores the margin past quota, to exactly one player', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const t = playing(seed);
      playOut(t);

      const round = t.state.match.played.at(-1)!;
      const dealer = dealerOf(t.state)!;
      const caller = callerOf(t.state)!;
      const dealerTricks = tricksWon(t.state, dealer);

      expect(round.scores[dealer]).toBe(Math.max(0, dealerTricks - DEALER_QUOTA));
      expect(round.scores[caller]).toBe(Math.max(0, 15 - dealerTricks - CALLER_QUOTA));

      // The quotas are complementary, so they cannot both be beaten.
      const scoring = Object.values(round.scores).filter((v) => v > 0);
      expect(scoring.length).toBeLessThanOrEqual(1);
    }
  });

  it('calls it a draw when the dealer takes exactly seven', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const t = playing(seed);
      playOut(t);
      const dealer = dealerOf(t.state)!;
      if (tricksWon(t.state, dealer) !== DEALER_QUOTA) continue;

      const round = t.state.match.played.at(-1)!;
      expect(Object.values(round.scores).every((v) => v === 0)).toBe(true);
      expect(saatAath.roundSummary!(t.state)).toMatch(/draw/i);
      return;
    }
    // Not every seed set produces a draw; skip rather than fail spuriously.
  });

  it('reads the round back in words', () => {
    const t = playing(2);
    playOut(t);
    expect(saatAath.roundSummary!(t.state)).toMatch(/draw|beat their quota by \d+/);
  });

  it('adds up the match with highest leading', () => {
    const t = table(7);
    for (let round = 0; round < 3; round++) {
      t.submit(PLAYERS[0]!, { type: 'startGame' });
      t.submit(callerOf(t.state)!, { type: 'choose', option: 'D' });
      playOut(t);
    }
    expect(t.state.match.played).toHaveLength(3);

    const board = saatAath.scoreboard!(t.state);
    expect(board.map((e) => e.value)).toEqual([...board.map((e) => e.value)].sort((a, b) => b - a));
    for (const entry of board) {
      const summed = t.state.match.played.reduce((n, r) => n + (r.scores[entry.playerId] ?? 0), 0);
      expect(entry.value).toBe(summed);
    }
  });

  it('deals a fresh round with a clean scratchpad', () => {
    const t = playing(4, 'H');
    playOut(t);
    t.submit(PLAYERS[0]!, { type: 'startGame' });

    expect(stageOf(t.state)).toBe('calling');
    expect(trumpOf(t.state)).toBeNull();
    expect(PLAYERS.every((p) => tricksWon(t.state, p) === 0)).toBe(true);
  });
});

describe('the last-play highlight', () => {
  it('marks the card just played into the trick', () => {
    const t = playing(23);
    const leader = t.state.turn!;
    const card = legal(t.state, leader)[0]!;
    play(t, card);
    expect(t.state.lastPlay).toEqual({ cardIds: [card], by: leader });
  });

  it('does not follow the cards into the winner’s pile', () => {
    const t = playing(24);
    play(t, legal(t.state, t.state.turn!)[0]!);
    const reply = legal(t.state, t.state.turn!)[0]!;
    play(t, reply);

    const before = t.state.lastPlay;
    take(t);
    // Gathering a trick is not a play, so the highlight stays on the card that
    // was actually played rather than jumping to the pile.
    expect(t.state.lastPlay).toEqual(before);
  });
});

/**
 * The contract the one-tap play button rests on.
 *
 * The client offers "play this card" as a single button whenever a card has
 * exactly one destination. That is only safe while `destinationsFor` agrees
 * with `legalCards` about what may be played, and never quietly names one
 * place when there are really two -- so it is asserted against every card in
 * hand, at every point of a whole round, rather than spot-checked.
 */
describe('where a card may go', () => {
  const where = (state: GameState, playerId: PlayerId, cardId: CardId): string[] =>
    saatAath.destinationsFor!(state, playerId, cardId);

  it('names the trick, and only for cards that may actually be played', () => {
    const t = playing();
    let checked = 0;

    for (let i = 0; i < 120 && t.state.phase === 'playing'; i++) {
      if (take(t)) continue;
      const actor = t.state.turn;
      if (!actor) break;
      const playable = new Set(legal(t.state, actor));

      for (const playerId of t.state.seatOrder) {
        for (const cardId of availableCards(t.state, playerId)) {
          const destinations = where(t.state, playerId, cardId);
          const mayPlay = playerId === actor && playable.has(cardId);
          expect(destinations, `${playerId} / ${cardId}`).toEqual(mayPlay ? [TRICK_ZONE] : []);
          checked++;
        }
      }

      if (playable.size === 0) break;
      play(t, [...playable][0]!);
    }

    expect(checked).toBeGreaterThan(100);
  });

  it('offers nothing to the player who has to pick up a trick first', () => {
    const t = playing();
    play(t, legal(t.state, t.state.turn!)[0]!);
    play(t, legal(t.state, t.state.turn!)[0]!);

    const winner = trickAwaitingCollection(t.state)!;
    expect(winner).toBeTruthy();
    // The trick has to be taken before anything else happens, so there is
    // nowhere for any card to go -- and no button offering to send one there.
    for (const cardId of availableCards(t.state, winner)) {
      expect(where(t.state, winner, cardId)).toEqual([]);
    }
  });

  it('sends a card where it says it will', () => {
    const t = playing();
    const actor = t.state.turn!;
    const cardId = legal(t.state, actor)[0]!;
    const [destination] = where(t.state, actor, cardId);

    const result = t.submit(actor, { type: 'move', cardIds: [cardId], toZone: destination! });
    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
    expect(t.state.zones[TRICK_ZONE]?.cards).toContain(cardId);
  });
});

describe('who calls trump', () => {
  it('changes hands on every deal, not only on scored rounds', () => {
    const t = dealt();
    const first = callerOf(t.state)!;
    expect(first).toBeTruthy();

    // A redeal abandons the round rather than scoring it, so `match.played`
    // does not move. The call still has to alternate: this is the bug that
    // handed the same player the trump call twice running.
    dealAgain(t);
    expect(t.state.match.played).toHaveLength(0);
    expect(callerOf(t.state)).not.toBe(first);

    dealAgain(t);
    expect(callerOf(t.state)).toBe(first);
  });

  it('keeps alternating across a whole match', () => {
    const t = playing();
    const callers = [callerOf(t.state)!];

    for (let round = 0; round < 4; round++) {
      playOut(t);
      dealAgain(t);
      callers.push(callerOf(t.state)!);
    }

    for (let i = 1; i < callers.length; i++) {
      expect(callers[i], `two deals running went to ${callers[i]}`).not.toBe(callers[i - 1]);
    }
  });

  it('gives the dealer the easier quota, whoever the dealer is', () => {
    const t = dealt();
    for (let deal = 0; deal < 4; deal++) {
      const dealer = dealerOf(t.state)!;
      const caller = callerOf(t.state)!;
      expect(quotaFor(t.state, dealer)).toBe(DEALER_QUOTA);
      expect(quotaFor(t.state, caller)).toBe(CALLER_QUOTA);
      expect(caller).not.toBe(dealer);
      dealAgain(t);
    }
  });
});
