/**
 * Badam Saat -- बदाम सात -- the Indian name for the game played elsewhere as
 * Sevens, Fan Tan, Card Dominoes or Parliament.
 *
 * The whole deck is dealt out. Four rows are built on the table, one per suit,
 * each starting from its seven and growing outward -- six, five, four down one
 * way and eight, nine, ten up the other. On your turn you play one card that
 * continues a row, or starts one with a seven. First player out of cards wins.
 *
 * House rules this implementation pins down, both of which vary in the wild:
 *
 *   - **Ace is low.** Rows run A-2-...-7-...-K. Some traditions rank the ace
 *     above the king instead.
 *   - **The holder of the seven of hearts opens** and must play it. Hearts is
 *     what the game is named for -- *badam* is the hearts suit -- and it is
 *     the suit this version has always been dealt around. The alternative --
 *     the player left of the dealer begins -- can open with a forced pass,
 *     which is a poor first move in a game people are learning.
 *
 * The rule worth having a computer for is the one a physical table cannot
 * check: **you must play if you can.** Passing is legal only when you are
 * genuinely stuck, and `legalCards` lets the client show you why.
 */

import { buildDeck, shuffled, type Rng } from '../deck.js';
import { TABLE_INTENTS, type EventBody, type GameEvent, type Intent } from '../intents.js';
import {
  RANK_ORDER,
  cardPoints,
  rankValue,
  type Card,
  type CardId,
  type GameState,
  type PlayerId,
  type Suit,
  type Zone,
  type ZoneId,
} from '../state.js';
import {
  ALLOW,
  type Ruleset,
  type Score,
  type SetupContext,
  type SetupSpec,
  type Verdict,
} from './types.js';

const SUITS: readonly Suit[] = ['S', 'H', 'D', 'C'] as const;
/** The order a hand is grouped in when sorted: the two reds kept apart. */
const HAND_SUITS: readonly Suit[] = ['S', 'H', 'C', 'D'] as const;
/** Touching your own cards: never a move, so never the ruleset's to refuse. */
const HANDLING: readonly Intent['type'][] = ['grab', 'release', 'peek'];
/**
 * The card that opens the game, and the reason for the name: *badam* is
 * hearts, *saat* is seven.
 *
 * Exported so that the tests, and anything else that has to know how a game
 * begins, ask the ruleset rather than each keeping their own copy of the
 * answer.
 */
export const OPENING_CARD = 'H7';
const SEVEN = 7;

export function rowZoneId(suit: Suit): ZoneId {
  return `row:${suit}`;
}

function rowZone(suit: Suit, index: number): Zone {
  return {
    id: rowZoneId(suit),
    kind: 'row',
    owner: null,
    layout: 'spread',
    // Everything on the layout is public -- that is the point of a layout.
    faceDownVisibleTo: 'all',
    // Cards go onto a row and never come off it.
    openToOthers: false,
    sealed: true,
    cards: [],
    pos: { x: 0.5, y: 0.2 + index * 0.13 },
    label: suit,
  };
}

function handZone(playerId: PlayerId): Zone {
  return {
    id: `hand:${playerId}`,
    kind: 'hand',
    owner: playerId,
    layout: 'fan',
    faceDownVisibleTo: 'owner',
    openToOthers: false,
    cards: [],
  };
}

// --- reading the layout ----------------------------------------------------

interface RowRange {
  low: number;
  high: number;
}

/** The span of ranks already down in a suit, or null if the row is empty. */
function rangeOf(state: GameState, suit: Suit): RowRange | null {
  const zone = state.zones[rowZoneId(suit)];
  if (!zone || zone.cards.length === 0) return null;

  let low = Infinity;
  let high = -Infinity;
  for (const cardId of zone.cards) {
    const face = state.cards[cardId]?.face;
    if (!face) continue;
    const value = rankValue(face.rank);
    if (value < low) low = value;
    if (value > high) high = value;
  }
  return low === Infinity ? null : { low, high };
}

/**
 * Whether this card continues its suit's row.
 *
 * Deliberately reads only the layout, never a hand, so it gives the same
 * answer on the server and on a client that cannot see anyone else's cards.
 */
export function isPlayable(state: GameState, card: Card): boolean {
  if (!card.face || card.face.suit === null) return false; // jokers sit out
  const value = rankValue(card.face.rank);
  const range = rangeOf(state, card.face.suit);

  // An empty row can only be opened with its seven.
  if (!range) return value === SEVEN;
  return value === range.low - 1 || value === range.high + 1;
}

export function legalCards(state: GameState, playerId: PlayerId): CardId[] {
  if (state.phase !== 'playing' || state.turn !== playerId) return [];

  const hand = state.zones[`hand:${playerId}`];
  if (!hand) return [];

  // Before anything is down, only the seven of hearts opens.
  const opening = Object.values(state.zones).every(
    (zone) => zone.kind !== 'row' || zone.cards.length === 0,
  );
  if (opening) return hand.cards.filter((id) => id === OPENING_CARD);

  return hand.cards.filter((id) => {
    const card = state.cards[id];
    return card ? isPlayable(state, card) : false;
  });
}

/** Whose deal it is to open: whoever holds the seven of hearts. */
function openerOf(zones: Zone[]): PlayerId | null {
  for (const zone of zones) {
    if (zone.kind === 'hand' && zone.cards.includes(OPENING_CARD)) return zone.owner;
  }
  return null;
}

function nextTurn(state: GameState, from: PlayerId | null): PlayerId | null {
  const order = state.inPlay.length > 0 ? state.inPlay : state.seatOrder;
  if (order.length === 0) return null;
  const current = from ? order.indexOf(from) : -1;
  return order[(current + 1) % order.length] ?? null;
}

function handCount(state: GameState, playerId: PlayerId): number {
  return state.zones[`hand:${playerId}`]?.cards.length ?? 0;
}

/**
 * What a player's remaining hand is worth: ace one, pip cards their own
 * number, jack eleven, queen twelve, king thirteen.
 *
 * Whoever went out is holding nothing, so their total is zero without needing
 * a special case -- which is the rule stated exactly as it is played.
 */
export function handValue(state: GameState, playerId: PlayerId): number {
  const hand = state.zones[`hand:${playerId}`]?.cards ?? [];
  return hand.reduce((total, cardId) => {
    const face = state.cards[cardId]?.face;
    return total + (face ? cardPoints(face.rank) : 0);
  }, 0);
}

/** Every player's score for the round that has just ended. */
export function roundScores(state: GameState): Record<PlayerId, number> {
  const scores: Record<PlayerId, number> = {};
  for (const playerId of state.inPlay) scores[playerId] = handValue(state, playerId);
  return scores;
}

// --- the ruleset -----------------------------------------------------------

export const sevens: Ruleset = {
  id: 'sevens',
  name: 'बदाम सात',
  blurb: 'Build each suit outward from its seven. First player out of cards wins.',
  // Three or more is the real game; two is allowed so a table can be tried out.
  minPlayers: 2,
  maxPlayers: 8,
  autoStart: false,
  scoreDirection: 'low',
  scoreNote: 'Lowest total leads — you score what you are left holding.',
  // "Knock" is the traditional word and means nothing to anybody meeting the
  // game here for the first time. The button is only ever pressable when you
  // are stuck, so the plain description of what it does is the better label --
  // and it keeps the status pill short enough for a phone.
  passLabel: 'Skip turn',
  // Ace on the left through king on the right, which is the direction the
  // rows themselves run: a sorted hand reads the same way round as the table.
  handOrder: { suits: HAND_SUITS, ranks: RANK_ORDER },

  setup({ players, rng }: SetupContext): SetupSpec {
    const zones: Zone[] = SUITS.map(rowZone);
    const hands = players.map(handZone);
    const cards = buildDeck('deck');
    const byId = new Map(cards.map((card) => [card.id, card]));

    // Deal the whole pack round the table one card at a time. An uneven split
    // is normal and needs no correction -- 52 rarely divides by the number of
    // people at a table.
    const order = shuffled(
      cards.map((card) => card.id),
      rng,
    );
    order.forEach((cardId, index) => {
      const hand = hands[index % hands.length];
      const card = byId.get(cardId);
      if (!hand || !card) return;
      hand.cards.push(cardId);
      card.zone = hand.id;
      // A card in hand lies face down on the table; its owner still sees it,
      // which is `faceDownVisibleTo: 'owner'` doing the work, not this flag.
      card.faceUp = false;
    });

    return {
      zones: [...zones, ...hands],
      cards,
      options: { enforceTurnOrder: true, handsArePrivate: true, anyoneMayShuffle: false },
      firstTurn: openerOf(hands),
    };
  },

  validate(state: GameState, intent: Intent, actor: PlayerId): Verdict {
    // Starting the next deal is the only thing to do once someone has won.
    if (state.phase !== 'playing') {
      return TABLE_INTENTS.includes(intent.type)
        ? ALLOW
        : { ok: false, reason: 'the game is not in play' };
    }

    switch (intent.type) {
      case 'move': {
        // Tidying your own hand is always fine, in or out of turn -- but
        // tidying means rearranging cards already in it, not fetching one
        // back off the table.
        if (intent.toZone === `hand:${actor}`) {
          return intent.cardIds.every((id) => state.cards[id]?.zone === `hand:${actor}`)
            ? ALLOW
            : { ok: false, reason: 'a card that is down stays down' };
        }

        if (state.turn !== actor) return { ok: false, reason: 'wait for your turn' };
        if (intent.cardIds.length !== 1) return { ok: false, reason: 'play one card at a time' };

        const cardId = intent.cardIds[0]!;
        const card = state.cards[cardId];
        if (!card) return { ok: false, reason: 'no such card' };
        if (card.zone !== `hand:${actor}`) {
          return { ok: false, reason: 'play a card from your own hand' };
        }
        if (!card.face || card.face.suit === null) {
          return { ok: false, reason: 'that card has no place in this game' };
        }
        if (intent.toZone !== rowZoneId(card.face.suit)) {
          return { ok: false, reason: `the ${card.face.rank} belongs on the ${card.face.suit} row` };
        }
        if (!isPlayable(state, card)) {
          const range = rangeOf(state, card.face.suit);
          return {
            ok: false,
            reason: range
              ? 'that card does not continue the row yet'
              : 'a row can only be opened with its seven',
          };
        }
        if (legalCards(state, actor).length > 0 && !legalCards(state, actor).includes(cardId)) {
          return { ok: false, reason: 'the seven of hearts opens the game' };
        }
        return ALLOW;
      }

      case 'passTurn': {
        if (state.turn !== actor) return { ok: false, reason: 'wait for your turn' };
        // The rule a physical table cannot enforce: you must play if you can.
        const playable = legalCards(state, actor);
        if (playable.length > 0) {
          return { ok: false, reason: 'you have a playable card — you cannot pass' };
        }
        return ALLOW;
      }

      // Nothing else belongs in a game of Sevens. The deck is fully dealt, so
      // there is nothing to shuffle, draw or turn over.
      default:
        // Administering the table and handling your own cards are not moves in
        // the game. Read from one shared list rather than restated as cases,
        // so a new table-level intent cannot be allowed in one ruleset and
        // refused in another.
        return TABLE_INTENTS.includes(intent.type) || HANDLING.includes(intent.type)
          ? ALLOW
          : { ok: false, reason: 'not part of this game' };
    }
  },

  after(state: GameState, event: GameEvent): EventBody[] {
    // When it is over, everyone turns over what they were left holding. That
    // is what happens at a real table, and there is nothing left to protect:
    // hand sizes were public all along, so the ranking is already known.
    if (event.type === 'gameEnded') {
      const stillHeld = state.seatOrder.flatMap((playerId) => state.zones[`hand:${playerId}`]?.cards ?? []);
      if (stillHeld.length === 0) return [];
      return [{ type: 'cardsRevealed', cardIds: stillHeld, to: [...state.seatOrder] }];
    }

    if (state.phase !== 'playing') return [];

    if (event.type === 'cardsMoved') {
      const ontoRow = event.placements.some(
        (placement) => state.zones[placement.toZone]?.kind === 'row',
      );
      if (!ontoRow) return []; // a hand tidy-up, not a play

      const player = event.actor;
      // Going out ends it. The rest are ranked by what they were left holding,
      // which is the natural way a table works out who came second.
      if (player && handCount(state, player) === 0) {
        // The rest are ranked by what they are left holding, which is also
        // what they score -- so the ranking and the scoreboard cannot
        // disagree, because they are the same numbers.
        const scores = roundScores(state);
        const others = state.inPlay
          .filter((id) => id !== player)
          .sort((a, b) => (scores[a] ?? 0) - (scores[b] ?? 0));
        return [{ type: 'gameEnded', rankings: [player, ...others], scores }];
      }

      return [{ type: 'turnSet', playerId: nextTurn(state, player) }];
    }

    return [];
  },

  legalCards,

  /**
   * A Sevens card has exactly one home: the row for its suit.
   *
   * There is no choice to make here, which is what makes the one-tap play
   * honest -- the client is not picking a destination on the player's behalf,
   * it is skipping a step that only ever had one answer.
   */
  destinationsFor(state: GameState, playerId: PlayerId, cardId: CardId): ZoneId[] {
    if (!legalCards(state, playerId).includes(cardId)) return [];
    const suit = state.cards[cardId]?.face?.suit;
    return suit ? [rowZoneId(suit)] : [];
  },

  scoreboard(state: GameState): Score[] {
    // Running totals across the match, lowest first -- in Sevens the point is
    // to be left holding as little as possible.
    const players = new Set<PlayerId>(state.seatOrder);
    for (const round of state.match.played) {
      for (const playerId of Object.keys(round.scores)) players.add(playerId);
    }

    return [...players]
      .map((playerId) => ({
        playerId,
        label: 'points',
        value: state.match.played.reduce((total, round) => total + (round.scores[playerId] ?? 0), 0),
      }))
      .sort((a, b) => a.value - b.value);
  },
};
