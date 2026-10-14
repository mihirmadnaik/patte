/**
 * The parts of trick-taking that belong to no particular game.
 *
 * Two games here are built on the same thirty-card pack and the same idea: a
 * suit is led, everyone follows if they can, the highest trump takes it. Those
 * rules are identical whether the table seats two or three, so they live here
 * once rather than twice -- "which card wins" is precisely the rule least
 * worth having two copies of.
 *
 * What stays with each game is what each game actually decides for itself:
 * how many cards are dealt and when, who names trump, what everyone's quota
 * is, and how the result is scored.
 */

import type { Card, CardId, GameState, PlayerId, Point, Rank, Suit, Zone, ZoneId } from '../state.js';

/**
 * The short pack both games use: no card below a seven, and only two sevens.
 *
 * Thirty cards divides by two and by three, which is why the same pack serves
 * a fifteen-trick game for two players and a ten-trick game for three.
 */
export const SHORT_PACK_RANKING: readonly Rank[] = ['A', 'K', 'Q', 'J', '10', '9', '8', '7'] as const;
/** Every seven except the two the pack keeps. */
export const DROPPED_SEVENS = ['C7', 'D7'] as const;
/** The suits a caller may name, in the order they are offered. */
export const TRUMP_SUITS: readonly Suit[] = ['S', 'H', 'D', 'C'] as const;
/** The order a hand is grouped in when sorted: the two reds kept apart. */
export const HAND_SUITS: readonly Suit[] = ['S', 'H', 'C', 'D'] as const;

/**
 * Suits in words, for the things a ruleset says out loud.
 *
 * User-facing text belongs to the ruleset -- it already owns its name, its
 * blurb and how its scores read -- so a suit it needs to announce is spelled
 * here rather than translated back by whoever displays it.
 */
export const SUIT_LABEL: Record<Suit, string> = {
  S: '♠ spades',
  H: '♥ hearts',
  D: '♦ diamonds',
  C: '♣ clubs',
};

export const TRICK_ZONE: ZoneId = 'trick';
/** Where cards that have been dealt but not handed out yet wait. */
export const STOCK_ZONE: ZoneId = 'stock';
/** The option value for picking up a won trick. */
export const TAKE = 'take';

export function pileZoneId(playerId: PlayerId): ZoneId {
  return `pile:${playerId}`;
}

// --- card strength ---------------------------------------------------------

/** Position in the ranking; lower is stronger. Ace is 0. */
function rankOrder(rank: Rank): number {
  const at = SHORT_PACK_RANKING.indexOf(rank);
  return at === -1 ? SHORT_PACK_RANKING.length : at;
}

/**
 * Whether `challenger` beats `leader`, told outright which of the two are
 * trumps.
 *
 * Separated from `beats` because trumpiness is not always a property of the
 * card: in लॅडीस the trump suit is face down for part of the hand, and a card
 * of that suit played before it was turned up was never a trump. So whether
 * something is a trump can depend on *when* it was played, and the comparison
 * has to be able to be told rather than work it out.
 */
function stronger(
  challenger: Card,
  leader: Card,
  led: Suit,
  aTrump: boolean,
  bTrump: boolean,
): boolean {
  const a = challenger.face?.suit;
  const b = leader.face?.suit;
  if (!a || !b || !challenger.face || !leader.face) return false;

  if (aTrump !== bTrump) return aTrump;

  // Same category now: either both trumps or neither. A card off-suit and
  // off-trump cannot win whatever its rank.
  if (!aTrump && a !== led) return false;
  if (!aTrump && b !== led) return true;

  return rankOrder(challenger.face.rank) < rankOrder(leader.face.rank);
}

/**
 * Whether `challenger` beats `leader`, given what was led and what is trump.
 *
 * Trump beats non-trump; otherwise only a card of the led suit can win, and
 * between two cards of one suit the higher rank takes it. That is the entire
 * rule -- no exceptions, which is what dropping the super-trumps buys.
 */
export function beats(challenger: Card, leader: Card, led: Suit, trump: Suit): boolean {
  return stronger(
    challenger,
    leader,
    led,
    challenger.face?.suit === trump,
    leader.face?.suit === trump,
  );
}

// --- reading the table -----------------------------------------------------

export type Stage = 'calling' | 'playing';

export function stageOf(state: GameState): Stage {
  return state.gameData['stage'] === 'playing' ? 'playing' : 'calling';
}

export function trumpOf(state: GameState): Suit | null {
  const trump = state.gameData['trump'];
  return typeof trump === 'string' && TRUMP_SUITS.includes(trump as Suit) ? (trump as Suit) : null;
}

export function dealerOf(state: GameState): PlayerId | null {
  const dealer = state.gameData['dealer'];
  return typeof dealer === 'string' ? dealer : null;
}

/** The cards currently in the middle, oldest first. */
export function trickCards(state: GameState): CardId[] {
  return state.zones[TRICK_ZONE]?.cards ?? [];
}

/**
 * The suit that must be followed, or null when nobody has led yet.
 *
 * A full trick is a finished one still sitting on the table, so the next card
 * played leads afresh rather than following it. `trickSize` is how many cards
 * make a full one -- one per player.
 */
export function suitLed(state: GameState, trickSize: number): Suit | null {
  const cards = trickCards(state);
  if (cards.length === 0 || cards.length >= trickSize) return null;
  return state.cards[cards[0]!]?.face?.suit ?? null;
}

/**
 * Whoever has won the trick sitting on the table, if one is waiting.
 *
 * A decided trick stays where it is until its winner picks it up. Sweeping it
 * away the instant the last card landed made it vanish before it could be
 * read, and doing it silently on their next lead was worse -- the cards
 * disappeared as a side effect of an unrelated action.
 *
 * The turn is set to the winner as soon as the trick fills, so "whose turn is
 * it" and "who won" are the same question until they take it.
 */
export function awaitingCollection(state: GameState, trickSize: number): PlayerId | null {
  if (state.phase !== 'playing' || stageOf(state) !== 'playing') return null;
  if (trickCards(state).length !== trickSize) return null;
  return state.turn;
}

/** How many tricks a player has taken, from the size of their pile. */
export function pileTricks(state: GameState, playerId: PlayerId, cardsPerTrick: number): number {
  const held = state.zones[pileZoneId(playerId)]?.cards.length ?? 0;
  return cardsPerTrick > 0 ? Math.floor(held / cardsPerTrick) : 0;
}

/**
 * Who took the trick.
 *
 * The cards sit in the order they were played and `order` is the seating they
 * were played in, so the only missing piece is where the round of play began.
 * That is counted back from whoever played last rather than recorded: the
 * trick holds one card per player from the leader onwards, so the leader is
 * always `cards.length - 1` seats behind the player who closed it. Recording
 * it instead would be a second fact to keep true.
 */
export function trickWinner(
  state: GameState,
  cards: readonly CardId[],
  lastActor: PlayerId,
  order: readonly PlayerId[],
  /** Null when the hand has no trump at all, as a वख्खै does. */
  trump: Suit | null,
): PlayerId | null {
  const seats = order.length;
  const closedAt = order.indexOf(lastActor);
  if (seats === 0 || closedAt < 0 || cards.length === 0) return null;

  const ledAt = (((closedAt - (cards.length - 1)) % seats) + seats) % seats;
  const led = state.cards[cards[0]!]?.face?.suit;
  if (!led) return null;

  const trumpy = (cardId: CardId): boolean =>
    trump !== null && state.cards[cardId]?.face?.suit === trump;

  let best = 0;
  for (let i = 1; i < cards.length; i++) {
    const challenger = state.cards[cards[i]!];
    const leader = state.cards[cards[best]!];
    if (challenger && leader && stronger(challenger, leader, led, trumpy(cards[i]!), trumpy(cards[best]!))) {
      best = i;
    }
  }

  return order[(ledAt + best) % seats] ?? null;
}

// --- the zones a trick game needs ------------------------------------------
//
// A plain hand is not one of them: free play already defines that, and it is
// the null ruleset these games are restrictions of, so there is no second
// version of "a player's hand" to keep in step.

export function pileZone(playerId: PlayerId): Zone {
  return {
    id: pileZoneId(playerId),
    kind: 'pile',
    owner: playerId,
    layout: 'stack',
    // Taken tricks are turned face down and stay that way: what you won is
    // yours, and nobody -- including you -- gets to leaf back through it.
    faceDownVisibleTo: 'none',
    openToOthers: false,
    sealed: true,
    cards: [],
    label: 'tricks',
  };
}

/**
 * Where the part of the pack that has not been handed out yet waits.
 *
 * Nobody sees these, including whoever they are destined for. Both games that
 * use it deal in two halves with a decision in between -- a trump call, an
 * auction -- and the decision is only difficult because the rest of the hand
 * genuinely is not known yet.
 */
export function stockZone(pos: Point = { x: 0.5, y: 0.4 }): Zone {
  return {
    id: STOCK_ZONE,
    kind: 'deck',
    owner: null,
    layout: 'stack',
    faceDownVisibleTo: 'none',
    openToOthers: false,
    cards: [],
    pos,
    label: 'to deal',
  };
}

export function trickZone(): Zone {
  return {
    id: TRICK_ZONE,
    kind: 'trick',
    owner: null,
    layout: 'spread',
    faceDownVisibleTo: 'all',
    openToOthers: false,
    cards: [],
    pos: { x: 0.5, y: 0.5 },
    label: 'trick',
  };
}
