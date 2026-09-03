import { describe, expect, it } from 'vitest';
import {
  buildDeck,
  checkInvariants,
  isPredictable,
  makeRng,
  predict,
  projectFor,
  shuffled,
} from '../src/index.js';
import { fuzz, newTable } from './helpers.js';

describe('card conservation', () => {
  it('keeps all 52 cards in exactly one zone through random play', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const table = newTable(['ana', 'ben', 'cal'], seed);
      fuzz(table, 150, seed);

      expect(checkInvariants(table.state)).toEqual([]);
      expect(Object.keys(table.state.cards)).toHaveLength(52);

      const filed = Object.values(table.state.zones).flatMap((z) => z.cards);
      expect(filed).toHaveLength(52);
      expect(new Set(filed).size).toBe(52);
    }
  });

  it('builds a pack of distinct cards', () => {
    const deck = buildDeck('deck');
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map((c) => c.id)).size).toBe(52);

    const twoPacks = buildDeck('deck', { packs: 2, jokers: 2 });
    expect(twoPacks).toHaveLength(106);
    expect(new Set(twoPacks.map((c) => c.id)).size).toBe(106);
  });
});

describe('replay determinism', () => {
  it('reproduces live state exactly from the log alone', () => {
    for (const seed of [3, 11, 42]) {
      const table = newTable(['ana', 'ben'], seed);
      fuzz(table, 200, seed);
      expect(table.replay()).toEqual(table.state);
    }
  });

  it('is reproducible across two tables given the same seed', () => {
    const a = newTable(['ana', 'ben'], 9);
    const b = newTable(['ana', 'ben'], 9);
    fuzz(a, 100, 9);
    fuzz(b, 100, 9);
    expect(a.state).toEqual(b.state);
  });
});

describe('grab locks', () => {
  it('lets exactly one player win a contested grab', () => {
    const table = newTable(['ana', 'ben']);
    const card = table.state.zones['deck']!.cards[0]!;

    expect(table.submit('ana', { type: 'grab', cardIds: [card] }).ok).toBe(true);
    const contested = table.submit('ben', { type: 'grab', cardIds: [card] });
    expect(contested.ok).toBe(false);
    if (!contested.ok) expect(contested.reason).toMatch(/holding/);

    expect(table.state.cards[card]!.heldBy).toBe('ana');
  });

  it('blocks a move of a card someone else is holding', () => {
    const table = newTable(['ana', 'ben']);
    const card = table.state.zones['deck']!.cards[0]!;
    table.submit('ana', { type: 'grab', cardIds: [card] });

    const denied = table.submit('ben', { type: 'move', cardIds: [card], toZone: 'discard' });
    expect(denied.ok).toBe(false);
    expect(table.state.cards[card]!.zone).toBe('deck');
  });

  it('releases the lock when the holder disconnects', () => {
    const table = newTable(['ana', 'ben']);
    const card = table.state.zones['deck']!.cards[0]!;
    table.submit('ana', { type: 'grab', cardIds: [card] });
    table.setConnected('ana', false);
    expect(table.state.cards[card]!.heldBy).toBeNull();
  });

  it('picks a card up and puts it back down in one move', () => {
    const table = newTable(['ana']);
    const card = table.state.zones['deck']!.cards[0]!;
    table.submit('ana', { type: 'move', cardIds: [card], toZone: 'discard' });
    expect(table.state.cards[card]!.zone).toBe('discard');
    expect(table.state.cards[card]!.heldBy).toBeNull();
  });
});

describe('zone access', () => {
  it('refuses to let a player reach into another hand', () => {
    const table = newTable(['ana', 'ben']);
    table.submit('ana', { type: 'deal', fromZone: 'deck', count: 3 });
    const benCard = table.state.zones['hand:ben']!.cards[0]!;

    const denied = table.submit('ana', { type: 'move', cardIds: [benCard], toZone: 'discard' });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toMatch(/reach/);
  });

  it('allows handing a card to another player', () => {
    const table = newTable(['ana', 'ben']);
    table.submit('ana', { type: 'deal', fromZone: 'deck', count: 3 });
    const anaCard = table.state.zones['hand:ana']!.cards[0]!;

    expect(table.submit('ana', { type: 'move', cardIds: [anaCard], toZone: 'hand:ben' }).ok).toBe(true);
    expect(table.state.cards[anaCard]!.zone).toBe('hand:ben');
  });

  it('refuses to reveal a card the actor cannot see', () => {
    const table = newTable(['ana', 'ben']);
    const deckCard = table.state.zones['deck']!.cards[0]!;
    const denied = table.submit('ana', { type: 'reveal', cardIds: [deckCard], to: 'all' });
    expect(denied.ok).toBe(false);
  });
});

describe('dealing', () => {
  it('deals round the table one card at a time', () => {
    const table = newTable(['ana', 'ben', 'cal']);
    const top = table.state.zones['deck']!.cards.slice(0, 6);
    table.submit('ana', { type: 'deal', fromZone: 'deck', count: 2 });

    // First card to Ana, second to Ben, third to Cal, then round again.
    expect(table.state.zones['hand:ana']!.cards).toEqual([top[0], top[3]]);
    expect(table.state.zones['hand:ben']!.cards).toEqual([top[1], top[4]]);
    expect(table.state.zones['hand:cal']!.cards).toEqual([top[2], top[5]]);
    expect(table.state.zones['deck']!.cards).toHaveLength(46);
  });

  it('refuses to deal more cards than the deck holds', () => {
    const table = newTable(['ana', 'ben']);
    const denied = table.submit('ana', { type: 'deal', fromZone: 'deck', count: 30 });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toMatch(/only 52/);
  });
});

describe('moves', () => {
  it('keeps the order of a run of cards dropped at one index', () => {
    const table = newTable(['ana']);
    table.submit('ana', { type: 'deal', fromZone: 'deck', count: 5 });
    const hand = [...table.state.zones['hand:ana']!.cards];
    const run = hand.slice(1, 4);

    table.submit('ana', { type: 'move', cardIds: run, toZone: 'table', toIndex: 0 });
    expect(table.state.zones['table']!.cards).toEqual(run);
  });

  it('gathers every card back to the deck, face down', () => {
    const table = newTable(['ana', 'ben'], 5);
    fuzz(table, 60, 5);
    table.submit('ana', { type: 'gather', toZone: 'deck' });

    expect(table.state.zones['deck']!.cards).toHaveLength(52);
    for (const card of Object.values(table.state.cards)) {
      expect(card.faceUp).toBe(false);
      expect(card.heldBy).toBeNull();
    }
  });
});

describe('shuffling', () => {
  it('permutes without gaining or losing a card', () => {
    const table = newTable(['ana']);
    const before = [...table.state.zones['deck']!.cards];
    table.submit('ana', { type: 'shuffle', zoneId: 'deck' });
    const after = table.state.zones['deck']!.cards;

    expect(after).toHaveLength(before.length);
    expect([...after].sort()).toEqual([...before].sort());
    expect(after).not.toEqual(before);
  });

  it('is a pure function of the seed', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(shuffled(items, makeRng(4))).toEqual(shuffled(items, makeRng(4)));
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('lets the owner lock shuffling to themselves', () => {
    const table = newTable(['ana', 'ben']);
    table.submit('ana', { type: 'setOption', key: 'anyoneMayShuffle', value: false });
    expect(table.submit('ben', { type: 'shuffle', zoneId: 'deck' }).ok).toBe(false);
    expect(table.submit('ana', { type: 'shuffle', zoneId: 'deck' }).ok).toBe(true);
  });
});

describe('turn order', () => {
  it('is off by default, so anyone may act', () => {
    const table = newTable(['ana', 'ben']);
    expect(table.submit('ben', { type: 'shuffle', zoneId: 'deck' }).ok).toBe(true);
  });

  it('gates shared zones but never a player own hand', () => {
    const table = newTable(['ana', 'ben']);
    table.submit('ana', { type: 'deal', fromZone: 'deck', count: 5 });
    table.submit('ana', { type: 'setOption', key: 'enforceTurnOrder', value: true });
    table.submit('ana', { type: 'setTurn', playerId: 'ana' });

    expect(table.submit('ben', { type: 'shuffle', zoneId: 'deck' }).ok).toBe(false);

    // Ben may still tidy his own cards while waiting.
    const benHand = table.state.zones['hand:ben']!.cards;
    const reorder = table.submit('ben', {
      type: 'move',
      cardIds: [benHand[2]!],
      toZone: 'hand:ben',
      toIndex: 0,
    });
    expect(reorder.ok).toBe(true);
  });

  it('passes round the seating order and wraps', () => {
    const table = newTable(['ana', 'ben', 'cal']);
    table.submit('ana', { type: 'setTurn', playerId: 'cal' });
    table.submit('cal', { type: 'passTurn' });
    expect(table.state.turn).toBe('ana');
  });
});

describe('the null ruleset', () => {
  it('adds no constraints of its own', () => {
    const table = newTable(['ana']);
    const before = table.state.seq;
    // Something no real game would permit: flipping the whole deck face up.
    const all = table.state.zones['deck']!.cards;
    expect(table.submit('ana', { type: 'flip', cardIds: all, faceUp: true }).ok).toBe(true);
    expect(table.state.seq).toBeGreaterThan(before);
  });
});

describe('prediction', () => {
  it('predicts a visible move and agrees with the server', () => {
    const table = newTable(['ana', 'ben']);
    table.submit('ana', { type: 'deal', fromZone: 'deck', count: 5 });

    const confirmed = projectFor(table.state, 'ana');
    const card = confirmed.zones['hand:ana']!.cards[0]!;
    const intent = { type: 'move', cardIds: [card], toZone: 'table' } as const;

    const predicted = predict(confirmed, [{ id: 1, intent }], 'ana');
    expect(predicted.cards[card]!.zone).toBe('table');

    table.submit('ana', intent);
    expect(projectFor(table.state, 'ana').cards[card]!.zone).toBe('table');
  });

  it('refuses to predict anything that depends on hidden cards', () => {
    const table = newTable(['ana']);
    const view = projectFor(table.state, 'ana');
    const hidden = view.zones['deck']!.cards[0]!;

    expect(isPredictable(view, { type: 'shuffle', zoneId: 'deck' })).toBe(false);
    expect(isPredictable(view, { type: 'deal', fromZone: 'deck', count: 1 })).toBe(false);
    // Turning a card you cannot see face up would mean inventing its face.
    expect(isPredictable(view, { type: 'flip', cardIds: [hidden], faceUp: true })).toBe(false);
    // Turning one face down is fine -- no face is needed to draw a back.
    expect(isPredictable(view, { type: 'flip', cardIds: [hidden], faceUp: false })).toBe(true);
  });

  it('drops a denied intent simply by leaving it out of the replay', () => {
    const table = newTable(['ana', 'ben']);
    table.submit('ana', { type: 'deal', fromZone: 'deck', count: 3 });
    const card = table.state.zones['hand:ana']!.cards[0]!;
    const confirmed = projectFor(table.state, 'ana');

    const pending = [
      { id: 1, intent: { type: 'move', cardIds: [card], toZone: 'table' } as const },
      { id: 2, intent: { type: 'flip', cardIds: [card], faceUp: true } as const },
    ];
    expect(predict(confirmed, pending, 'ana').cards[card]!.faceUp).toBe(true);

    // The server denies the flip; replaying without it is the whole rollback.
    const rolledBack = predict(confirmed, [pending[0]!], 'ana');
    expect(rolledBack.cards[card]!.zone).toBe('table');
    expect(rolledBack.cards[card]!.faceUp).toBe(false);
  });
});
