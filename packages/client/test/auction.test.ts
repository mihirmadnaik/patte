/**
 * The bidding stepper.
 *
 * All of this exists because the stepper used to hold an *index* into the
 * ladder of stakes. जजमेंट hands the dealer a ladder with one number removed
 * -- the hook -- so index 1 was the number 2, and a player stepping up once
 * from nothing registered two having asked for one.
 */

import { describe, expect, it } from 'vitest';
import { openingStake, questionOf, stepStake } from '../src/auction.js';

describe('stepping the ladder', () => {
  const whole = [0, 1, 2, 3, 4, 5];

  it('moves one rung at a time', () => {
    expect(stepStake(whole, 0, 1)).toBe(1);
    expect(stepStake(whole, 1, 1)).toBe(2);
    expect(stepStake(whole, 3, -1)).toBe(2);
  });

  it('stops at either end rather than wrapping', () => {
    expect(stepStake(whole, 0, -1)).toBe(0);
    expect(stepStake(whole, 5, 1)).toBe(5);
  });

  it('steps by value, so a gapped ladder still counts up by one', () => {
    // लॅडीस bids in eights: the rungs are not the numbers.
    const eights = [8, 16, 32];
    expect(stepStake(eights, 8, 1)).toBe(16);
    expect(stepStake(eights, 16, 1)).toBe(32);
    expect(stepStake(eights, 32, 1)).toBe(32);
  });

  it('starts from the nearest rung when the number has left the ladder', () => {
    // The answer stood at 16 and the ladder has since shortened past it.
    expect(stepStake([8, 16], 32, -1)).toBe(8);
    expect(stepStake([8, 16], 32, 0)).toBe(16);
  });

  it('is unmoved by an empty ladder', () => {
    expect(stepStake([], 3, 1)).toBe(3);
  });

  /**
   * The bug itself, from both ends.
   *
   * With the hooked number cut out of the ladder, one step up from nothing
   * landed on two. With the ladder whole, it lands on one -- and one is
   * refused by name instead of vanishing.
   */
  it('lands on one when a player asks for one, hook or no hook', () => {
    const gapped = [0, 2, 3, 4, 5]; // what the ruleset used to send
    expect(stepStake(gapped, 0, 1)).toBe(2);

    const mended = [0, 1, 2, 3, 4, 5]; // what it sends now
    expect(stepStake(mended, 0, 1)).toBe(1);
  });
});

describe('where the stepper opens', () => {
  it('opens on the lowest rung', () => {
    expect(openingStake([0, 1, 2])).toBe(0);
    expect(openingStake([8, 16, 32])).toBe(8);
  });

  it('steps past the lowest rung when that is the barred one', () => {
    // Opening on a number that cannot be said shows a dead button as the
    // default, which reads as the panel being broken.
    expect(openingStake([0, 1, 2], { stake: 0 })).toBe(1);
    expect(openingStake([0, 1, 2], { stake: 1 })).toBe(0);
  });

  it('has nothing to open on when there is nothing on offer', () => {
    expect(openingStake([])).toBeUndefined();
  });
});

describe('which question the stepper is answering', () => {
  it('is a different question for a different bidder', () => {
    expect(questionOf({ bidder: 'ana', stakes: [0, 1] })).not.toBe(
      questionOf({ bidder: 'ben', stakes: [0, 1] }),
    );
  });

  it('is a different question for a different ladder', () => {
    // A new round deals fewer cards, so the same seat is asked something new
    // and must not keep a number chosen for the old one.
    expect(questionOf({ bidder: 'ana', stakes: [0, 1, 2] })).not.toBe(
      questionOf({ bidder: 'ana', stakes: [0, 1] }),
    );
  });

  it('is the same question while nothing has changed', () => {
    expect(questionOf({ bidder: 'ana', stakes: [0, 1] })).toBe(
      questionOf({ bidder: 'ana', stakes: [0, 1] }),
    );
  });
});
