/**
 * Asking the rules what a player will be allowed to play.
 *
 * Two things are pinned here, and they are different kinds of claim.
 *
 * `legalWhenOnTurn` is arithmetic: the same question `legalCards` answers,
 * asked with the turn moved. The risk in it is that moving the turn changes
 * something else -- that a ruleset reads `state.turn` for a second purpose
 * somewhere further down -- so the test that matters is the one comparing it
 * against the real answer when the real turn arrives.
 *
 * `premoveReady` is a promise about the near future: that nothing anybody
 * does between now and this player's turn can change what they may play. It
 * is asserted here at every point where that stops being true -- before the
 * lead, after this player has already played, on a finished trick, during
 * every auction the four games have, and in a hand that may yet be thrown in.
 */

import { describe, expect, it } from 'vitest';
import {
  TAKE,
  TRICK_ZONE,
  Table,
  getRuleset,
  judgement,
  laddis,
  legalWhenOnTurn,
  makeRng,
  pachTinDon,
  saatAath,
  sevens,
  type CardId,
  type GameState,
  type PlayerId,
  type Ruleset,
} from '../src/index.js';

function table(rulesetId: string, players: string[], seed = 1): Table {
  let clock = 1_700_000_000_000;
  const t = new Table({
    roomId: 'prem',
    rulesetId,
    rng: makeRng(seed),
    now: () => clock++,
    strict: true,
  });
  t.create();
  for (const name of players) t.addPlayer(name, name);
  // Free play deals itself; everything else waits to be told.
  if (!getRuleset(rulesetId).autoStart) {
    const started = t.submit(players[0]!, { type: 'startGame' });
    if (!started.ok) throw new Error(started.reason);
  }
  return t;
}

const hand = (state: GameState, playerId: PlayerId): CardId[] =>
  state.zones[`hand:${playerId}`]?.cards ?? [];
const trick = (state: GameState): CardId[] => state.zones[TRICK_ZONE]?.cards ?? [];

/** Answer whatever is being asked, until a card can be played. */
function intoPlay(t: Table, ruleset: Ruleset): void {
  for (let step = 0; step < 40; step++) {
    const auction = ruleset.auction?.(t.state);
    if (auction) {
      const option =
        auction.passOption ??
        `${auction.stakePrefix}${auction.stakes.filter((n) => n !== auction.barred?.stake)[0]}`;
      const said = t.submit(auction.bidder, { type: 'choose', option });
      if (!said.ok) throw new Error(`${auction.bidder}: ${said.reason}`);
      continue;
    }
    const call = ruleset.trumpCall?.(t.state);
    if (call) {
      const said = t.submit(call.chooser, { type: 'choose', option: 'S' });
      if (!said.ok) throw new Error(`${call.chooser}: ${said.reason}`);
      continue;
    }
    // लॅडीस sets its trump aside as a card rather than naming a suit.
    const turn = t.state.turn;
    if (turn && (ruleset.legalCards?.(t.state, turn) ?? []).length > 0) {
      const [cardId] = ruleset.legalCards!(t.state, turn);
      const [toZone] = ruleset.destinationsFor?.(t.state, turn, cardId!) ?? [TRICK_ZONE];
      if (toZone === TRICK_ZONE) return; // a card can be played: we are in play
      const moved = t.submit(turn, { type: 'move', cardIds: [cardId!], toZone: toZone! });
      if (!moved.ok) throw new Error(`${turn}: ${moved.reason}`);
      continue;
    }
    return;
  }
}

/** Lead the first card of a trick, and say who is on turn after it. */
function lead(t: Table, ruleset: Ruleset): PlayerId {
  const leader = t.state.turn!;
  const [cardId] = ruleset.legalCards!(t.state, leader);
  const played = t.submit(leader, { type: 'move', cardIds: [cardId!], toZone: TRICK_ZONE });
  if (!played.ok) throw new Error(`${leader} leading: ${played.reason}`);
  return leader;
}

const GAMES: { id: string; ruleset: Ruleset; players: string[] }[] = [
  { id: 'saat-aath', ruleset: saatAath, players: ['ana', 'ben'] },
  { id: 'pach-tin-don', ruleset: pachTinDon, players: ['ana', 'ben', 'cal'] },
  { id: 'laddis', ruleset: laddis, players: ['ana', 'ben', 'cal', 'dev'] },
  { id: 'judgement', ruleset: judgement, players: ['ana', 'ben', 'cal', 'dev'] },
];

describe('what a player will be allowed to play', () => {
  it('agrees with the plain question when it is already your turn', () => {
    for (const { id, ruleset, players } of [
      ...GAMES,
      { id: 'sevens', ruleset: sevens, players: ['ana', 'ben', 'cal'] },
    ]) {
      const t = table(id, players);
      intoPlay(t, ruleset);
      const turn = t.state.turn;
      if (!turn) continue;
      expect(legalWhenOnTurn(ruleset, t.state, turn), id).toEqual(
        ruleset.legalCards!(t.state, turn),
      );
    }
  });

  it('gives a waiting player the set they are really offered when their turn comes', () => {
    // The claim the whole feature rests on: what the rules say now is what
    // they will say then.
    for (const { id, ruleset, players } of GAMES) {
      const t = table(id, players);
      intoPlay(t, ruleset);
      lead(t, ruleset);

      const waiting = t.state.turn!;
      const foreseen = legalWhenOnTurn(ruleset, t.state, waiting);
      expect(foreseen.length, `${id}: nothing foreseen`).toBeGreaterThan(0);
      expect(foreseen, id).toEqual(ruleset.legalCards!(t.state, waiting));
    }
  });

  it('follows the led suit where the player can, and opens the hand where they cannot', () => {
    const t = table('judgement', ['ana', 'ben', 'cal', 'dev']);
    intoPlay(t, judgement);
    lead(t, judgement);

    const led = t.state.cards[trick(t.state)[0]!]!.face!.suit;
    for (const playerId of t.state.inPlay.filter((id) => id !== t.state.playedBy[trick(t.state)[0]!])) {
      const held = hand(t.state, playerId);
      const following = held.filter((id) => t.state.cards[id]?.face?.suit === led);
      expect(legalWhenOnTurn(judgement, t.state, playerId), playerId).toEqual(
        following.length > 0 ? following : held,
      );
    }
  });

  it('answers nothing for a game with no rules about it', () => {
    const t = table('freeplay', ['ana', 'ben']);
    expect(legalWhenOnTurn(getRuleset('freeplay'), t.state, 'ana')).toEqual([]);
  });
});

describe('whether the lead has settled it', () => {
  it('is false before anybody has led', () => {
    for (const { id, ruleset, players } of GAMES) {
      const t = table(id, players);
      intoPlay(t, ruleset);
      for (const playerId of players) {
        expect(ruleset.premoveReady!(t.state, playerId), `${id}/${playerId}`).toBe(false);
      }
    }
  });

  it('is true for everybody still to play, once the lead is down', () => {
    for (const { id, ruleset, players } of GAMES) {
      const t = table(id, players);
      intoPlay(t, ruleset);
      const leader = lead(t, ruleset);

      for (const playerId of t.state.inPlay) {
        const expected = playerId !== leader && playerId !== t.state.turn;
        expect(ruleset.premoveReady!(t.state, playerId), `${id}/${playerId}`).toBe(expected);
      }
    }
  });

  it('is false for the player on turn, who has no waiting to do', () => {
    for (const { id, ruleset, players } of GAMES) {
      const t = table(id, players);
      intoPlay(t, ruleset);
      lead(t, ruleset);
      expect(ruleset.premoveReady!(t.state, t.state.turn!), id).toBe(false);
    }
  });

  it('is false for somebody who has already played to this trick', () => {
    // Their next card belongs to a trick nobody has led, so nothing about it
    // is settled.
    const t = table('judgement', ['ana', 'ben', 'cal', 'dev']);
    intoPlay(t, judgement);
    const leader = lead(t, judgement);
    const second = t.state.turn!;
    const [cardId] = judgement.legalCards!(t.state, second);
    t.submit(second, { type: 'move', cardIds: [cardId!], toZone: TRICK_ZONE });

    expect(judgement.premoveReady!(t.state, leader)).toBe(false);
    expect(judgement.premoveReady!(t.state, second)).toBe(false);
    expect(judgement.premoveReady!(t.state, t.state.turn!)).toBe(false);
    // The one player who has neither led nor played nor is on turn.
    const last = t.state.inPlay.find(
      (id) => id !== leader && id !== second && id !== t.state.turn,
    )!;
    expect(judgement.premoveReady!(t.state, last)).toBe(true);
  });

  it('is false while a finished trick waits to be picked up', () => {
    const t = table('judgement', ['ana', 'ben', 'cal', 'dev']);
    intoPlay(t, judgement);
    for (let i = 0; i < 4; i++) {
      const turn = t.state.turn!;
      const [cardId] = judgement.legalCards!(t.state, turn);
      if (!cardId) break;
      t.submit(turn, { type: 'move', cardIds: [cardId], toZone: TRICK_ZONE });
    }
    expect(trick(t.state)).toHaveLength(4);
    for (const playerId of t.state.inPlay) {
      expect(judgement.premoveReady!(t.state, playerId), playerId).toBe(false);
    }

    // And true again for the waiting players once the next trick is led.
    const winner = t.state.turn!;
    t.submit(winner, { type: 'choose', option: TAKE });
    lead(t, judgement);
    expect(judgement.premoveReady!(t.state, t.state.inPlay.find((id) => id !== winner && id !== t.state.turn)!)).toBe(true);
  });

  it('is false in every लॅडीस stage that is not play', () => {
    const t = table('laddis', ['ana', 'ben', 'cal', 'dev']);
    // The bidding, before anybody has passed.
    expect(t.state.gameData['stage']).toBe('bidding');
    for (const playerId of t.state.inPlay) {
      expect(laddis.premoveReady!(t.state, playerId), `bidding/${playerId}`).toBe(false);
    }

    // The trump being set aside.
    for (let i = 0; i < 4; i++) {
      const auction = laddis.auction!(t.state);
      if (!auction) break;
      t.submit(auction.bidder, { type: 'choose', option: auction.passOption! });
    }
    expect(t.state.gameData['stage']).toBe('calling');
    for (const playerId of t.state.inPlay) {
      expect(laddis.premoveReady!(t.state, playerId), `calling/${playerId}`).toBe(false);
    }
  });

  it('is false while a four-7s hand may still be thrown in', () => {
    const t = table('laddis', ['ana', 'ben', 'cal', 'dev']);
    for (let i = 0; i < 4; i++) {
      const auction = laddis.auction!(t.state);
      if (!auction) break;
      t.submit(auction.bidder, { type: 'choose', option: auction.passOption! });
    }
    const caller = t.state.inPlay[0]!;
    t.submit(caller, { type: 'move', cardIds: [hand(t.state, caller)[0]!], toZone: 'trump' });

    // Hand every seven to one player, as the लॅडीस suite does.
    const holder = t.state.inPlay[1]!;
    const sevenIds = Object.values(t.state.cards)
      .filter((card) => card.face?.rank === '7')
      .map((card) => card.id);
    const zones = structuredClone(t.state.zones);
    const cards = structuredClone(t.state.cards);
    const mine = zones[`hand:${holder}`]!;
    const spare = mine.cards.filter((id) => !sevenIds.includes(id)).slice(0, sevenIds.length);
    for (const zone of Object.values(zones)) {
      zone.cards = zone.cards.filter((id) => !sevenIds.includes(id));
    }
    mine.cards = [...mine.cards.filter((id) => !spare.includes(id)), ...sevenIds];
    for (const id of sevenIds) cards[id]!.zone = mine.id;
    const elsewhere = zones[`hand:${caller}`]!;
    elsewhere.cards = [...elsewhere.cards, ...spare];
    for (const id of spare) cards[id]!.zone = elsewhere.id;
    t.state = { ...t.state, zones, cards };

    for (const playerId of t.state.inPlay) {
      expect(laddis.premoveReady!(t.state, playerId), playerId).toBe(false);
    }
  });

  it('is not a question बदाम सात answers at all', () => {
    // Every card played there opens somebody's next play, so nothing is
    // settled in advance. The hook is absent rather than false, which is how
    // a game stays out of this without having to opt out.
    expect(sevens.premoveReady).toBeUndefined();
    expect(getRuleset('freeplay').premoveReady).toBeUndefined();
  });
});
