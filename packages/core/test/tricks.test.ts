/**
 * The shared trick-taking rules.
 *
 * Both games lean on these, so a mistake here is a mistake in two places at
 * once. `trickWinner` in particular does something non-obvious — it works out
 * where the round of play began by counting back from whoever closed the
 * trick — and that arithmetic is worth pinning at both table sizes.
 */

import { describe, expect, it } from 'vitest';
import { beats, trickWinner, type Card, type GameState, type Suit } from '../src/index.js';

function card(id: string): Card {
  return {
    id,
    face: { suit: id[0] as Suit, rank: id.slice(1) as 'A' },
    zone: 'trick',
    faceUp: true,
    revealedTo: [],
    heldBy: null,
    version: 0,
  } as Card;
}

function tableOf(ids: string[]): GameState {
  return { cards: Object.fromEntries(ids.map((id) => [id, card(id)])) } as unknown as GameState;
}

describe('which card beats which', () => {
  const cases: [string, string, Suit, Suit, boolean][] = [
    // challenger, leader, led, trump, challenger wins?
    ['HK', 'HQ', 'H', 'S', true],
    ['HQ', 'HK', 'H', 'S', false],
    ['S8', 'HA', 'H', 'S', true], // any trump beats the best of the led suit
    ['HA', 'S8', 'H', 'S', false],
    ['DA', 'HQ', 'H', 'S', false], // off-suit and off-trump cannot win
    ['SA', 'SK', 'H', 'S', true], // two trumps: rank decides
    ['H7', 'HA', 'H', 'S', false], // the seven is an ordinary low card
  ];

  for (const [challenger, leader, led, trump, expected] of cases) {
    it(`${challenger} ${expected ? 'beats' : 'loses to'} ${leader} (led ${led}, trump ${trump})`, () => {
      const state = tableOf([challenger, leader]);
      expect(beats(state.cards[challenger]!, state.cards[leader]!, led, trump)).toBe(expected);
    });
  }
});

describe('who took the trick', () => {
  it('finds the leader by counting back from whoever closed it', () => {
    const order = ['ana', 'ben', 'cal'];
    const cards = ['HQ', 'HK', 'H9'];
    const state = tableOf(cards);
    // 'cal' played last, so 'ana' led — and the king in the middle wins.
    expect(trickWinner(state, cards, 'cal', order, 'S')).toBe('ben');
  });

  it('wraps round the table when the lead is not the first seat', () => {
    const order = ['ana', 'ben', 'cal'];
    const cards = ['HQ', 'HK', 'H9'];
    const state = tableOf(cards);
    // 'ben' closed it, so 'cal' led: cal played HQ, ana HK, ben H9.
    expect(trickWinner(state, cards, 'ben', order, 'S')).toBe('ana');
  });

  it('gives it to the trump, wherever in the trick it fell', () => {
    const order = ['ana', 'ben', 'cal'];
    const cards = ['HA', 'S7', 'HK'];
    const state = tableOf(cards);
    expect(trickWinner(state, cards, 'cal', order, 'S')).toBe('ben');
  });

  it('works for a two-handed trick as well', () => {
    const order = ['ana', 'ben'];
    const cards = ['D9', 'DJ'];
    const state = tableOf(cards);
    expect(trickWinner(state, cards, 'ben', order, 'S')).toBe('ben');
  });

  it('has no answer for a trick nobody could have played', () => {
    const state = tableOf(['HA']);
    expect(trickWinner(state, ['HA'], 'nobody', ['ana', 'ben'], 'S')).toBeNull();
    expect(trickWinner(state, [], 'ana', ['ana', 'ben'], 'S')).toBeNull();
  });
});
