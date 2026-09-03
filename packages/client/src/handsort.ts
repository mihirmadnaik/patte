/**
 * Reading your own hand in an order that helps.
 *
 * This is a *view*, not a move. The engine never reorders a zone and nothing
 * is sent to the server, which is the point: an opponent can see the card ids
 * in your hand and the positions you play from, so a hand sorted on the wire
 * would let them work out how your cards rank against each other simply by
 * watching which slot each played card came from. Sorting locally tells them
 * nothing, and it survives nothing -- reload and the hand is as dealt.
 */

import type { GameState, HandOrder, Ruleset } from '@patte/core';

/** Ace on the left through king on the right, spades first. */
const DEFAULT_ORDER: HandOrder = {
  suits: ['S', 'H', 'C', 'D'],
  ranks: ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'],
};

export function handOrderFor(ruleset: Ruleset): HandOrder {
  return ruleset.handOrder ?? DEFAULT_ORDER;
}

/**
 * The hand, in reading order.
 *
 * A card whose face this client cannot see keeps its dealt position rather
 * than being bundled to one end: there is nothing to sort it by, and a sort
 * that quietly grouped the unknown cards together would say something about
 * them. In practice that is only ever somebody else's hand, which is never
 * sorted anyway.
 */
export function sortHand(state: GameState, order: HandOrder, cardIds: readonly string[]): string[] {
  const rank = (cardId: string): number => {
    const face = state.cards[cardId]?.face;
    if (!face) return Number.MAX_SAFE_INTEGER;
    const suit = order.suits.indexOf(face.suit ?? 'S');
    const value = order.ranks.indexOf(face.rank);
    // An unknown suit or rank sorts to the end of its group rather than to the
    // front, where `indexOf`'s -1 would otherwise put it.
    return (suit < 0 ? order.suits.length : suit) * 100 + (value < 0 ? order.ranks.length : value);
  };

  return [...cardIds].sort((a, b) => rank(a) - rank(b));
}
