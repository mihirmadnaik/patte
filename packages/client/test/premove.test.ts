/**
 * What becomes of a card armed before its turn.
 *
 * The two failures this guards against are opposite and both bad: playing a
 * card after the moment for it has gone, and sitting on one while the table
 * waits. Every case below is one of the moments where which of those is the
 * risk changes.
 */

import { describe, expect, it } from 'vitest';
import { premoveAction } from '../src/premove.js';
import type { GameState } from '@patte/core';

/** The smallest table this decision can be made against. */
function table(options: {
  turn?: string | null;
  phase?: GameState['phase'];
  zone?: string;
}): GameState {
  return {
    phase: options.phase ?? 'playing',
    turn: options.turn === undefined ? 'ben' : options.turn,
    cards: { H9: { id: 'H9', zone: options.zone ?? 'hand:ana' } },
  } as unknown as GameState;
}

const ask = (args: Partial<Parameters<typeof premoveAction>[0]> = {}) =>
  premoveAction({
    queued: 'H9',
    state: table({}),
    you: 'ana',
    legalNow: [],
    ...args,
  });

describe('a card armed before its turn', () => {
  it('waits while somebody else is playing', () => {
    expect(ask()).toBe('hold');
  });

  it('does nothing at all when nothing is armed', () => {
    expect(ask({ queued: null })).toBe('hold');
    // And nothing before there is a table to be armed against.
    expect(ask({ state: null })).toBe('hold');
    expect(ask({ you: null })).toBe('hold');
  });

  it('goes down when the turn arrives and the rules still allow it', () => {
    expect(ask({ state: table({ turn: 'ana' }), legalNow: ['H9', 'SK'] })).toBe('fire');
  });

  it('is dropped when the turn arrives and the rules do not', () => {
    // Should be unreachable -- the window is built so an armed card is always
    // still legal. The rules get the last word anyway, because the cost of
    // being wrong is a card played against them.
    expect(ask({ state: table({ turn: 'ana' }), legalNow: ['SK'] })).toBe('drop');
  });

  it('is dropped once the card has left the hand it was armed from', () => {
    // Played, withdrawn for a वख्खै, or swept up by a redeal: whatever
    // happened to it, it is not ours to play.
    expect(ask({ state: table({ zone: 'trick' }) })).toBe('drop');
    expect(ask({ state: table({ zone: 'hand:ben' }) })).toBe('drop');
  });

  it('is dropped when the hand is over, whoever the turn says it is', () => {
    // A finished hand still carries a turn, so the phase has to be asked
    // first or an armed card would fire into the scoreboard.
    expect(ask({ state: table({ phase: 'finished', turn: 'ana' }), legalNow: ['H9'] })).toBe('drop');
    expect(ask({ state: table({ phase: 'lobby', turn: 'ana' }), legalNow: ['H9'] })).toBe('drop');
  });
});

describe('arming and taking it back', () => {
  // The store rather than the component, because the component cannot be
  // tested here -- but "one at a time" and "tap it again to take it back" are
  // claims about state, and this is where that state lives.
  it('holds one card at a time, and lets go of it', async () => {
    const { useStore } = await import('../src/store.js');

    useStore.getState().queue('H9');
    expect(useStore.getState().queued).toBe('H9');

    // Arming a second is changing your mind about the first, not asking for
    // two plays.
    useStore.getState().queue('SK');
    expect(useStore.getState().queued).toBe('SK');

    // Which is what the Stop button and a tap on the card both do.
    useStore.getState().unqueue();
    expect(useStore.getState().queued).toBeNull();
  });

  it('clears the selection when a card is armed', () => {
    // The card has been let go of, so it is no longer being held.
    return import('../src/store.js').then(({ useStore }) => {
      useStore.getState().select(['H9']);
      useStore.getState().queue('H9');
      expect(useStore.getState().selection).toEqual([]);
      useStore.getState().unqueue();
    });
  });

  it('forgets an armed card when the table is left', () => {
    return import('../src/store.js').then(({ useStore }) => {
      useStore.getState().queue('H9');
      useStore.getState().reset();
      expect(useStore.getState().queued).toBeNull();
    });
  });
});
