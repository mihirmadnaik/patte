import { describe, expect, it } from 'vitest';
import { getRuleset, type Card, type GameState } from '@patte/core';
import { handOrderFor, sortHand } from '../src/handsort.js';

/** Just enough state for the sorter: cards with faces. */
function stateWith(ids: string[]): GameState {
  const cards: Record<string, Card> = {};
  for (const id of ids) {
    const suit = id[0] as 'S';
    const rank = id.slice(1) as 'A';
    cards[id] = {
      id,
      face: { suit, rank },
      zone: 'hand:me',
      faceUp: false,
      revealedTo: [],
      heldBy: null,
      version: 0,
    } as Card;
  }
  return { cards } as unknown as GameState;
}

const HAND = ['D7', 'SA', 'HK', 'S10', 'CA', 'H2', 'SK', 'DA'];

describe('sorting a hand for reading', () => {
  it('groups by suit, spades then hearts then clubs then diamonds', () => {
    const sorted = sortHand(stateWith(HAND), handOrderFor(getRuleset('sevens')), HAND);
    expect(sorted.map((id) => id[0]).join('')).toBe('SSSHHCDD');
  });

  it('runs ace to king in Sevens, the way the rows do', () => {
    const sorted = sortHand(stateWith(HAND), handOrderFor(getRuleset('sevens')), HAND);
    expect(sorted).toEqual(['SA', 'S10', 'SK', 'H2', 'HK', 'CA', 'DA', 'D7']);
  });

  it('runs strongest first in 7-8, the way the game ranks them', () => {
    const hand = ['D7', 'SA', 'HK', 'S10', 'CA', 'S8', 'SK', 'DA'];
    const sorted = sortHand(stateWith(hand), handOrderFor(getRuleset('saat-aath')), hand);
    expect(sorted).toEqual(['SA', 'SK', 'S10', 'S8', 'HK', 'CA', 'DA', 'D7']);
  });

  it('leaves a hand of the same cards, however it is ordered', () => {
    const sorted = sortHand(stateWith(HAND), handOrderFor(getRuleset('sevens')), HAND);
    expect([...sorted].sort()).toEqual([...HAND].sort());
  });

  it('sends a card it cannot read to the end rather than to the front', () => {
    const state = stateWith(HAND);
    state.cards['SA']!.face = null;
    const sorted = sortHand(state, handOrderFor(getRuleset('sevens')), HAND);
    expect(sorted.at(-1)).toBe('SA');
  });

  it('falls back to ace-low for a game with nothing to say about it', () => {
    const order = handOrderFor(getRuleset('freeplay'));
    expect(order.ranks[0]).toBe('A');
    expect(order.ranks.at(-1)).toBe('K');
  });
});
