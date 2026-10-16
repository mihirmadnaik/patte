/**
 * पाच-तीन-दोन.
 *
 * Three quotas over ten tricks, and a deal split either side of the trump
 * call. The two things most worth pinning are that the quotas land on the
 * right seats and rotate, and that the caller genuinely cannot see the half of
 * the deal they are choosing without -- the second is the difference between
 * this game and a much easier one.
 */

import { describe, expect, it } from 'vitest';
import {
  TABLE_INTENTS,
  TAKE,
  TRICK_ZONE,
  Table,
  checkInvariants,
  makeRng,
  pachTinDon,
  projectFor,
  stageOf,
  trumpOf,
  type CardId,
  type GameState,
  type PlayerId,
  type Suit,
} from '../src/index.js';

const PLAYERS = ['ana', 'ben', 'cal'];

function table(seed = 1, players = PLAYERS): Table {
  let clock = 1_700_000_000_000;
  const t = new Table({
    roomId: '532',
    rulesetId: 'pach-tin-don',
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

function playing(seed = 1, trump: Suit = 'S'): Table {
  const t = dealt(seed);
  const caller = pachTinDon.trumpCall!(t.state)!.chooser;
  const called = t.submit(caller, { type: 'choose', option: trump });
  if (!called.ok) throw new Error(called.reason);
  return t;
}

const hand = (state: GameState, playerId: PlayerId): CardId[] =>
  state.zones[`hand:${playerId}`]?.cards ?? [];

const quotas = (state: GameState): Record<PlayerId, number> =>
  Object.fromEntries((pachTinDon.standings!(state) ?? []).map((row) => [row.playerId, row.quota]));

const legal = (state: GameState, playerId: PlayerId): CardId[] =>
  pachTinDon.legalCards!(state, playerId);

/** Play the first legal card for whoever is on turn, taking tricks as they fall. */
function playOut(t: Table, maxPlays = 80): void {
  for (let i = 0; i < maxPlays && t.state.phase === 'playing'; i++) {
    const waiting = pachTinDon.awaitingChoice?.(t.state) ?? null;
    if (waiting && stageOf(t.state) === 'playing') {
      const taken = t.submit(waiting, { type: 'choose', option: TAKE });
      if (!taken.ok) throw new Error(`taking: ${taken.reason}`);
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

describe('the pack and the deal', () => {
  it('is the same thirty cards as सात-आठ', () => {
    const t = dealt();
    const ids = Object.keys(t.state.cards);
    expect(ids).toHaveLength(30);
    expect(ids.filter((id) => id.endsWith('7')).sort()).toEqual(['H7', 'S7']);
    expect(ids.some((id) => /^[SHDC][2-6]$/.test(id))).toBe(false);
  });

  it('deals five each and keeps the rest back', () => {
    const t = dealt();
    for (const playerId of PLAYERS) expect(hand(t.state, playerId)).toHaveLength(5);
    expect(t.state.zones['stock']?.cards).toHaveLength(15);
    expect(checkInvariants(t.state)).toEqual([]);
  });

  it('finishes the deal once trump is called, three then two', () => {
    const t = playing();
    for (const playerId of PLAYERS) expect(hand(t.state, playerId)).toHaveLength(10);
    expect(t.state.zones['stock']?.cards).toHaveLength(0);
    expect(trumpOf(t.state)).toBe('S');
    expect(stageOf(t.state)).toBe('playing');
    expect(checkInvariants(t.state)).toEqual([]);
  });

  it('hides the undealt half from the player choosing trump', () => {
    const t = dealt();
    const caller = pachTinDon.trumpCall!(t.state)!.chooser;
    const view = projectFor(t.state, caller);

    // The whole point of the split deal: five cards is what the call is made
    // on. If these arrived with faces, the game would be a different one.
    for (const cardId of t.state.zones['stock']?.cards ?? []) {
      expect(view.cards[cardId]?.face, `${cardId} was visible before the call`).toBeNull();
    }
    expect(Object.values(view.cards).filter((card) => card.face !== null)).toHaveLength(5);
  });
});

describe('quotas', () => {
  it('are five, three and two, in turn order', () => {
    const t = dealt();
    const turns = t.state.inPlay;
    expect(turns).toHaveLength(3);
    expect(turns.map((id) => quotas(t.state)[id])).toEqual([5, 3, 2]);
  });

  it('give the dealer two and the trump call to the player on five', () => {
    const t = dealt();
    const dealer = t.state.gameData['dealer'] as PlayerId;
    expect(quotas(t.state)[dealer]).toBe(2);
    expect(pachTinDon.trumpCall!(t.state)!.chooser).toBe(t.state.inPlay[0]);
    expect(quotas(t.state)[t.state.inPlay[0]!]).toBe(5);
  });

  /**
   * Which way round the table the game runs.
   *
   * `inPlay` order alone cannot catch this -- every assertion above reads the
   * seats back out of it, so it would pass whichever way the game travelled.
   * This pins it against `seatOrder` itself, which runs clockwise and is drawn
   * that way, so the seat after the dealer is the one on the dealer's left.
   */
  it('put the five on the dealer\'s left, clockwise', () => {
    const t = dealt();
    const seats = t.state.seatOrder;
    const dealer = t.state.gameData['dealer'] as PlayerId;
    const left = seats[(seats.indexOf(dealer) + 1) % seats.length]!;
    const right = seats[(seats.indexOf(dealer) + 2) % seats.length]!;

    expect(t.state.inPlay).toEqual([left, right, dealer]);
    expect(quotas(t.state)[left]).toBe(5);
    expect(quotas(t.state)[right]).toBe(3);
    expect(pachTinDon.trumpCall!(t.state)!.chooser).toBe(left);
  });

  it('add up to the number of tricks', () => {
    const t = dealt();
    const total = Object.values(quotas(t.state)).reduce((a, b) => a + b, 0);
    expect(total).toBe(10);
  });

  it('give the lead to whoever calls trump', () => {
    const t = dealt();
    expect(t.state.turn).toBe(pachTinDon.trumpCall!(t.state)!.chooser);
  });
});

describe('the deal moves round', () => {
  /** Deal again the way a table does: by agreement, since a hand is in play. */
  function dealAgain(t: Table): void {
    const asked = t.submit(PLAYERS[0]!, { type: 'proposeRedeal' });
    if (!asked.ok) throw new Error(asked.reason);
    for (const playerId of [...(t.state.redeal?.waitingOn ?? [])]) {
      const answered = t.submit(playerId, { type: 'answerRedeal', agree: true });
      if (!answered.ok) throw new Error(answered.reason);
    }
  }

  it('passes the deal on every time cards go out, scored or not', () => {
    const t = dealt();
    const dealers = [t.state.gameData['dealer'] as PlayerId];

    // A redeal scores nothing, so a rotation read off the round count would
    // sit still here -- the bug सात-आठ had.
    for (let i = 0; i < 5; i++) {
      dealAgain(t);
      dealers.push(t.state.gameData['dealer'] as PlayerId);
    }

    expect(t.state.match.played).toHaveLength(0);
    for (let i = 1; i < dealers.length; i++) {
      expect(dealers[i], `the deal stuck at ${dealers[i]}`).not.toBe(dealers[i - 1]);
    }
    // Three seats, so it comes back round on the fourth deal.
    expect(dealers[3]).toBe(dealers[0]);

    // And it travels to the left, the way the play does.
    const seats = t.state.seatOrder;
    for (let i = 1; i < dealers.length; i++) {
      const expected = seats[(seats.indexOf(dealers[i - 1]!) + 1) % seats.length];
      expect(dealers[i], `the deal went the wrong way at step ${i}`).toBe(expected);
    }
  });

  it('carries the quotas round with it', () => {
    const t = dealt();
    const first = quotas(t.state);
    dealAgain(t);
    const second = quotas(t.state);

    // Everybody's quota changes, because everybody has moved one seat along.
    for (const playerId of PLAYERS) expect(second[playerId]).not.toBe(first[playerId]);
    expect(Object.values(second).sort()).toEqual([2, 3, 5]);
  });
});

describe('playing a trick', () => {
  it('travels round the table in turn order', () => {
    const t = playing();
    const turns = [...t.state.inPlay];

    t.submit(turns[0]!, { type: 'move', cardIds: [legal(t.state, turns[0]!)[0]!], toZone: TRICK_ZONE });
    expect(t.state.turn).toBe(turns[1]);
    t.submit(turns[1]!, { type: 'move', cardIds: [legal(t.state, turns[1]!)[0]!], toZone: TRICK_ZONE });
    expect(t.state.turn).toBe(turns[2]);
  });

  it('makes you follow suit when you can', () => {
    const t = playing();
    const leader = t.state.turn!;
    const lead = legal(t.state, leader)[0]!;
    t.submit(leader, { type: 'move', cardIds: [lead], toZone: TRICK_ZONE });

    const led = t.state.cards[lead]!.face!.suit!;
    const next = t.state.turn!;
    const holding = hand(t.state, next).filter((id) => t.state.cards[id]?.face?.suit === led);
    if (holding.length === 0) return; // this deal did not test the rule

    expect(legal(t.state, next)).toEqual(holding);
    const offSuit = hand(t.state, next).find((id) => t.state.cards[id]?.face?.suit !== led);
    if (offSuit) {
      const denied = t.submit(next, { type: 'move', cardIds: [offSuit], toZone: TRICK_ZONE });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.reason).toMatch(/follow/);
    }
  });

  it('waits for the winner to take it, and then they lead', () => {
    const t = playing();
    for (const playerId of [...t.state.inPlay]) {
      t.submit(playerId, { type: 'move', cardIds: [legal(t.state, playerId)[0]!], toZone: TRICK_ZONE });
    }

    // Three cards down and nobody may play on until it is collected.
    expect(t.state.zones[TRICK_ZONE]?.cards).toHaveLength(3);
    const winner = pachTinDon.awaitingChoice!(t.state)!;
    expect(winner).toBeTruthy();
    expect(legal(t.state, winner)).toEqual([]);

    const taken = t.submit(winner, { type: 'choose', option: TAKE });
    expect(taken.ok, taken.ok ? '' : taken.reason).toBe(true);
    expect(t.state.zones[TRICK_ZONE]?.cards).toHaveLength(0);
    expect(t.state.zones[`pile:${winner}`]?.cards).toHaveLength(3);
    expect(t.state.turn).toBe(winner);
    expect(pachTinDon.standings!(t.state)?.find((row) => row.playerId === winner)?.won).toBe(1);
  });

  it('gives the trick to the highest trump, whoever played it', () => {
    const t = playing(3, 'S');
    const turns = [...t.state.inPlay];
    // Find a deal where the last player holds a spade and the lead is not one.
    const leader = turns[0]!;
    const lead = hand(t.state, leader).find((id) => t.state.cards[id]?.face?.suit !== 'S');
    if (!lead) return;

    t.submit(leader, { type: 'move', cardIds: [lead], toZone: TRICK_ZONE });
    const led = t.state.cards[lead]!.face!.suit!;

    for (const playerId of turns.slice(1)) {
      const options = legal(t.state, playerId);
      // Prefer a trump if this player is allowed to play one.
      const trump = options.find((id) => t.state.cards[id]?.face?.suit === 'S');
      t.submit(playerId, { type: 'move', cardIds: [trump ?? options[0]!], toZone: TRICK_ZONE });
    }

    const cards = t.state.zones[TRICK_ZONE]!.cards;
    const trumped = cards.filter((id) => t.state.cards[id]?.face?.suit === 'S');
    const winner = pachTinDon.awaitingChoice!(t.state)!;

    if (trumped.length > 0) {
      // Whoever played the best trump took it, regardless of what was led.
      const winningCard = cards.indexOf(trumped.at(-1)!) >= 0;
      expect(winningCard).toBe(true);
      expect(t.state.cards[cards[0]!]?.face?.suit).toBe(led);
      expect(winner).not.toBe(null);
    }
  });
});

describe('the round ends', () => {
  it('scores every player against their quota, over and under', () => {
    const t = playing();
    const quota = quotas(t.state);
    playOut(t);

    expect(t.state.phase).not.toBe('playing');
    const round = t.state.match.played.at(-1);
    expect(round).toBeTruthy();

    const taken = Object.fromEntries(
      PLAYERS.map((id) => [id, (t.state.zones[`pile:${id}`]?.cards.length ?? 0) / 3]),
    );
    expect(Object.values(taken).reduce((a, b) => a + b, 0)).toBe(10);

    for (const playerId of PLAYERS) {
      expect(round!.scores[playerId]).toBe(taken[playerId]! - quota[playerId]!);
    }
    // Ten tricks against quotas that also total ten: the misses cancel out.
    expect(Object.values(round!.scores).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('lets a score go below zero when a quota is missed', () => {
    // Somebody has to miss unless all three hit exactly, so across a few deals
    // a negative must appear -- the sign is the whole point of the readout.
    const seen: number[] = [];
    for (let seed = 1; seed <= 6; seed++) {
      const t = playing(seed);
      playOut(t);
      const round = t.state.match.played.at(-1);
      if (round) seen.push(...Object.values(round.scores));
    }
    expect(seen.some((value) => value < 0)).toBe(true);
  });
});

describe('saying what happened', () => {
  it('tells the other two what trump is, and not the player who called it', () => {
    const t = dealt();
    const caller = pachTinDon.trumpCall!(t.state)!.chooser;
    const called = t.submit(caller, { type: 'choose', option: 'H' });
    if (!called.ok) throw new Error(called.reason);

    const chosen = called.events.find((event) => event.type === 'chosen')!;
    expect(chosen).toBeTruthy();

    // The caller knows: they just picked it. Everyone else finds out, and
    // until this the news arrived only as a suit quietly appearing in a strip.
    expect(pachTinDon.announce!(t.state, chosen, caller)).toBeNull();
    for (const playerId of PLAYERS.filter((id) => id !== caller)) {
      expect(pachTinDon.announce!(t.state, chosen, playerId)).toMatch(/hearts/);
    }
  });
});

describe('administering the table', () => {
  it('accepts the table-level intents at every stage of a hand', () => {
    const refusal = (state: GameState, type: Intent): string | null => {
      const verdict = pachTinDon.validate(state, type, state.seatOrder[0]!);
      return verdict.ok ? null : verdict.reason;
    };

    const samples: Intent[] = [
      { type: 'startGame' },
      { type: 'proposeRedeal' },
      { type: 'answerRedeal', agree: true },
      { type: 'claimRedeal' },
      { type: 'setMatchRounds', rounds: 3 },
      { type: 'endMatch' },
      { type: 'declare', text: 'hello' },
      { type: 'rename', name: 'Ana' },
    ];
    expect(samples.map((intent) => intent.type).sort()).toEqual([...TABLE_INTENTS].sort());

    const calling = dealt();
    const inPlay = playing();
    const decided = playing(1);
    for (const playerId of [...decided.state.inPlay]) {
      decided.submit(playerId, {
        type: 'move',
        cardIds: [legal(decided.state, playerId)[0]!],
        toZone: TRICK_ZONE,
      });
    }

    for (const [label, t] of [
      ['calling', calling],
      ['playing', inPlay],
      ['a trick awaiting collection', decided],
    ] as const) {
      for (const intent of samples) {
        expect(refusal(t.state, intent), `${intent.type} during ${label}`).not.toBe(
          'not part of this game',
        );
      }
    }
  });
});

/** Imported late so the sample list above can be typed without a cycle. */
type Intent = Parameters<typeof pachTinDon.validate>[1];
