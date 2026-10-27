/**
 * The arithmetic behind the bidding stepper.
 *
 * Pulled out of the panel because it is the part that was wrong, and because
 * a component cannot be tested here -- the client's tests are all pure
 * functions, deliberately, since every rule lives in core.
 *
 * Two things went wrong in the version that held an index into the ladder.
 *
 * The ladder is not a fixed list: in जजमेंट the dealer's used to arrive with
 * the hooked number removed, so index 1 was the number 2, and stepping up
 * once from nothing registered two when the player had asked for one. An
 * index only means something next to the exact array it was taken from, and
 * that array changes between bidders, between rounds, and in लॅडीस between
 * one answer and the next.
 *
 * And stepping read the current index out of the render that drew the button,
 * so two taps landing in one batch both computed the same next value and the
 * second did nothing. Stepping from the previous *state* fixes that, which is
 * what `stepStake` is for.
 */

/** Which number a stepper lands on, moving `delta` rungs from `current`. */
export function stepStake(stakes: readonly number[], current: number, delta: number): number {
  if (stakes.length === 0) return current;
  const at = stakes.indexOf(current);
  // A number no longer on the ladder: start from the nearest one that is,
  // rather than from nowhere.
  const from = at === -1 ? nearestIndex(stakes, current) : at;
  const next = Math.min(stakes.length - 1, Math.max(0, from + delta));
  return stakes[next] ?? current;
}

/** The rung closest in value to a number that is not itself on the ladder. */
function nearestIndex(stakes: readonly number[], value: number): number {
  let best = 0;
  for (let i = 1; i < stakes.length; i++) {
    const candidate = stakes[i];
    const incumbent = stakes[best];
    if (candidate === undefined || incumbent === undefined) continue;
    if (Math.abs(candidate - value) < Math.abs(incumbent - value)) best = i;
  }
  return best;
}

/**
 * What the panel is being asked, as one string.
 *
 * The stepper keeps its number only while the question is the same one. A
 * different bidder, a different round or a different ladder is a different
 * question, and the answer starts again rather than carrying a number nobody
 * chose for it.
 */
export function questionOf(call: { bidder: string; stakes: readonly number[] }): string {
  return `${call.bidder}|${call.stakes.join(',')}`;
}

/** Where a stepper opens: the lowest rung, unless it is the barred one. */
export function openingStake(
  stakes: readonly number[],
  barred?: { stake: number },
): number | undefined {
  const first = stakes[0];
  if (first === undefined) return undefined;
  // Opening on a number that cannot be said would present a dead button as
  // the default, so it opens one rung along instead.
  if (barred && first === barred.stake) return stakes[1] ?? first;
  return first;
}
