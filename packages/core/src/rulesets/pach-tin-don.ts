/**
 * पाच-तीन-दोन (Paach Teen Don) — five, three, two.
 *
 * Three players, the same thirty-card pack as सात-आठ, ten tricks, and three
 * complementary quotas that add up to exactly the number of tricks: the player
 * to the dealer's right must take five, the dealer's left three, and the
 * dealer two. Known elsewhere as 2-3-5, 3-2-5 or teen do paanch.
 *
 * **The game is named after its own turn order.** The dealer's right leads,
 * then the dealer's left, then the dealer — five, three, two — so a single
 * ordering of the players gives both who plays when and who owes what. That is
 * why `inPlay` is built in that order and the quotas are read off it by
 * position rather than tracked separately: two facts that must agree are
 * better stored as one.
 *
 * The deal comes in two halves with the trump call between them, and that
 * split is the game rather than a flourish. The caller names trump on the
 * strength of five cards; dealing all ten first would be a different and much
 * easier decision, so the second half genuinely waits in the stock until the
 * call is made.
 */

import { buildDeck, shuffled } from '../deck.js';
import {
  TABLE_INTENTS,
  type CardPlacement,
  type EventBody,
  type GameEvent,
  type Intent,
} from '../intents.js';
import type { CardId, GameState, PlayerId, Suit, Zone, ZoneId } from '../state.js';
import { handZone } from './freeplay.js';
import {
  DROPPED_SEVENS,
  HAND_SUITS,
  SHORT_PACK_RANKING as RANKING,
  STOCK_ZONE,
  SUIT_LABEL,
  TAKE,
  TRICK_ZONE,
  TRUMP_SUITS,
  awaitingCollection,
  dealerOf,
  pileTricks,
  pileZone,
  stageOf,
  stockZone,
  suitLed,
  trickCards,
  trickWinner,
  trickZone,
  trumpOf,
} from './tricks.js';
import {
  ALLOW,
  type Ruleset,
  type Score,
  type SetupContext,
  type SetupSpec,
  type StandingsRow,
  type Verdict,
} from './types.js';

/** Touching your own cards: never a move, so never the ruleset's to refuse. */
const HANDLING: readonly Intent['type'][] = ['grab', 'release', 'peek'];

const SEATS = 3;
/** One card per player to a trick. */
const TRICK_SIZE = SEATS;
const TRICKS_PER_ROUND = 10;
/** Dealt before the call, then after it: five, then three, then two. */
const FIRST_BATCH = 5;
const LATER_BATCHES = [3, 2] as const;

/**
 * Quotas, in turn order: the leader owes five, the next three, the dealer two.
 *
 * Positional on purpose — see the note at the top of the file. `inPlay` is the
 * turn order, so a player's quota is just where they sit in it.
 */
const QUOTAS = [5, 3, 2] as const;

// --- reading the table -----------------------------------------------------
//
// None of this is exported. Every ruleset has a `callerOf` and a `quotaFor`,
// and only one of them can own the bare word -- so the way in from outside is
// this ruleset's own hooks (`trumpCall`, `standings`, `legalCards`), which is
// the same door the client uses.

/** Turn order, which is also quota order. */
function order(state: GameState): PlayerId[] {
  return [...state.inPlay];
}

/** Whoever names trump and leads: the player to the dealer's right. */
function callerOf(state: GameState): PlayerId | null {
  return state.inPlay[0] ?? null;
}

function quotaFor(state: GameState, playerId: PlayerId): number {
  const at = state.inPlay.indexOf(playerId);
  return at < 0 ? 0 : (QUOTAS[at] ?? 0);
}

function tricksTaken(state: GameState, playerId: PlayerId): number {
  return pileTricks(state, playerId, TRICK_SIZE);
}

/**
 * Tricks a player can count on, including one they have won but not yet
 * gathered, so the readout never says they are a trick worse off than they are.
 */
function tricksStanding(state: GameState, playerId: PlayerId): number {
  return tricksTaken(state, playerId) + (awaitingCollection(state, TRICK_SIZE) === playerId ? 1 : 0);
}

/**
 * Seats to one side of the dealer.
 *
 * `seatOrder` runs one way round the table; "right" is the seat before and
 * "left" the seat after. Which of those is physically to anybody's right is
 * unknowable from here and does not matter — what matters is that the two are
 * opposite, consistent, and that the deal and the play travel the same way.
 */
function rightOf(seats: readonly PlayerId[], playerId: PlayerId): PlayerId {
  const at = seats.indexOf(playerId);
  const n = seats.length;
  return seats[(((at - 1) % n) + n) % n] ?? playerId;
}

function leftOf(seats: readonly PlayerId[], playerId: PlayerId): PlayerId {
  const at = seats.indexOf(playerId);
  return seats[(at + 1) % seats.length] ?? playerId;
}

/** The hand a player may play from. There are no stacks in this game. */
function handCards(state: GameState, playerId: PlayerId): CardId[] {
  return state.zones[`hand:${playerId}`]?.cards ?? [];
}

/**
 * Not exported: reach it through `pachTinDon.legalCards`, the same way the
 * client does. Every ruleset has a function by this name and only one of them
 * can own the bare word.
 */
function legalCards(state: GameState, playerId: PlayerId): CardId[] {
  if (state.phase !== 'playing' || stageOf(state) !== 'playing') return [];
  if (state.turn !== playerId) return [];
  // A decided trick has to be picked up before anything may be played onto the
  // next one, or the client lights up cards the engine is about to refuse.
  if (awaitingCollection(state, TRICK_SIZE) !== null) return [];

  const hand = handCards(state, playerId);
  const led = suitLed(state, TRICK_SIZE);
  if (!led) return hand;

  const following = hand.filter((id) => state.cards[id]?.face?.suit === led);
  return following.length > 0 ? following : hand;
}

// --- setup -----------------------------------------------------------------

export const pachTinDon: Ruleset = {
  id: 'pach-tin-don',
  name: 'पाच-तीन-दोन',
  blurb:
    'Three players, thirty cards, ten tricks. Call trump and take your quota — five, three or two.',
  handOrder: { suits: HAND_SUITS, ranks: RANKING },
  minPlayers: SEATS,
  maxPlayers: SEATS,
  autoStart: false,
  scoreDirection: 'high',
  scoreNote: 'You score how far past your quota you got, and how far short if you missed it.',

  howToPlay: {
    goal: 'Take your quota of the ten tricks: five, three or two, depending on where you are sitting.',
    rules: [
      'Thirty cards, three players, ten tricks. The same pack as सात-आठ: nothing below a seven, and only the seven of hearts and the seven of spades.',
      'Five cards are dealt to each of you. Trump is named. Only then are the other five dealt — so the call is made on half a hand, which is the whole difficulty of it.',
      'The player to the dealer\'s right names trump, leads, and must take five. The dealer\'s left must take three. The dealer must take two.',
      'Follow the suit that was led if you can. The highest trump takes the trick; with no trump in it, the highest card of the suit led. Whoever wins it leads the next one.',
      'The quotas add up to ten exactly, so somebody beating theirs means somebody else missed. You score the difference either way, and it can be negative.',
      'The deal passes on each round, so the five, the three and the two move round the table with it.',
    ],
  },
  // No passing: you always hold something you are allowed to play.

  announce(state: GameState, event: GameEvent, viewer: PlayerId): string | null {
    if (event.type !== 'chosen' || event.actor === viewer) return null;
    const trump = trumpOf(state);
    if (!trump || event.option !== trump) return null;
    return `Trump is ${SUIT_LABEL[trump]}`;
  },

  trumpCall(state: GameState): { chooser: PlayerId; prompt: string } | null {
    if (state.phase !== 'playing' || stageOf(state) !== 'calling') return null;
    const chooser = callerOf(state);
    if (!chooser) return null;
    return {
      chooser,
      prompt: 'You have five cards. Name a trump suit — then the rest are dealt and you lead.',
    };
  },

  standings(state: GameState): StandingsRow[] | null {
    // Available from the moment the cards go out, not just once play starts:
    // the player choosing trump is choosing it knowing they owe five, and
    // that is precisely when it is worth having on screen.
    if (state.phase !== 'playing') return null;
    const dealer = dealerOf(state);
    return state.inPlay.map((playerId) => ({
      playerId,
      won: tricksStanding(state, playerId),
      quota: quotaFor(state, playerId),
      ...(playerId === dealer ? { note: 'deals' } : {}),
    }));
  },

  inlineChoice(
    state: GameState,
    playerId: PlayerId,
  ): { label: string; option: string; note?: string } | null {
    return awaitingCollection(state, TRICK_SIZE) === playerId
      ? { label: 'Take the trick', option: TAKE, note: 'You won that trick' }
      : null;
  },

  awaitingChoice(state: GameState): PlayerId | null {
    if (state.phase !== 'playing') return null;
    if (stageOf(state) === 'calling') return callerOf(state);
    return awaitingCollection(state, TRICK_SIZE);
  },

  setup({ players, rng, match, previous }: SetupContext): SetupSpec {
    // The deal passes to the right every time cards go out. Taken from the
    // previous *deal* rather than from the number of scored rounds: those
    // differ whenever a round ends without a score, and reading the round
    // count hands the trump call back to whoever just made it.
    const last = typeof previous['dealer'] === 'string' ? previous['dealer'] : null;
    const dealer =
      (last && players.includes(last)
        ? rightOf(players, last)
        : players[match.played.length % players.length]) ?? players[0]!;

    // Turn order is quota order: five, three, two.
    const turns = [rightOf(players, dealer), leftOf(players, dealer), dealer];

    const zones: Zone[] = [trickZone(), stockZone()];
    for (const playerId of players) zones.push(handZone(playerId), pileZone(playerId));

    const cards = buildDeck('deck', { ranks: RANKING, exclude: DROPPED_SEVENS });
    const byId = new Map(cards.map((card) => [card.id, card]));
    const shoe = shuffled(
      cards.map((card) => card.id),
      rng,
    );
    let next = 0;

    const zoneOf = (id: ZoneId): Zone => zones.find((zone) => zone.id === id)!;
    const place = (cardId: CardId, zone: Zone): void => {
      const card = byId.get(cardId);
      if (!card) return;
      zone.cards.push(cardId);
      card.zone = zone.id;
      card.faceUp = false;
    };

    // Five each, in turn order, starting with the player who will call trump.
    for (let i = 0; i < FIRST_BATCH; i++) {
      for (const playerId of turns) place(shoe[next++]!, zoneOf(`hand:${playerId}`));
    }

    // The rest waits where nobody can see it until trump is named.
    const stock = zoneOf(STOCK_ZONE);
    while (next < shoe.length) place(shoe[next++]!, stock);

    return {
      zones,
      cards,
      options: { handsArePrivate: true, enforceTurnOrder: true },
      firstTurn: turns[0] ?? null,
      inPlay: turns,
      gameData: { stage: 'calling', dealer },
    };
  },

  validate(state: GameState, intent: Intent, actor: PlayerId): Verdict {
    if (state.phase !== 'playing') {
      return TABLE_INTENTS.includes(intent.type)
        ? ALLOW
        : { ok: false, reason: 'the game is not in play' };
    }

    if (stageOf(state) === 'calling') {
      if (intent.type === 'choose') {
        if (actor !== callerOf(state)) return { ok: false, reason: 'the lead player calls trump' };
        if (!TRUMP_SUITS.includes(intent.option as Suit)) return { ok: false, reason: 'pick a suit' };
        return ALLOW;
      }
      return TABLE_INTENTS.includes(intent.type) || HANDLING.includes(intent.type)
        ? ALLOW
        : { ok: false, reason: 'waiting for trump to be called' };
    }

    // A decided trick has to be picked up before play continues.
    const waiting = awaitingCollection(state, TRICK_SIZE);
    if (waiting) {
      if (intent.type === 'choose') {
        if (actor !== waiting) return { ok: false, reason: 'that trick is not yours' };
        return intent.option === TAKE
          ? ALLOW
          : { ok: false, reason: 'there is a trick to take first' };
      }
      if (intent.type === 'move' && intent.toZone === TRICK_ZONE) {
        return {
          ok: false,
          reason: actor === waiting ? 'take the trick first' : 'wait for the trick to be taken',
        };
      }
    }

    switch (intent.type) {
      case 'move': {
        // Rearranging your own hand is fine; fetching back a card you played
        // is not.
        if (intent.toZone === `hand:${actor}`) {
          return intent.cardIds.every((id) => state.cards[id]?.zone === `hand:${actor}`)
            ? ALLOW
            : { ok: false, reason: 'a card that is played stays played' };
        }

        if (state.turn !== actor) return { ok: false, reason: 'wait for your turn' };
        if (intent.toZone !== TRICK_ZONE) return { ok: false, reason: 'play cards to the middle' };
        if (intent.cardIds.length !== 1) return { ok: false, reason: 'play one card at a time' };

        const cardId = intent.cardIds[0]!;
        if (legalCards(state, actor).includes(cardId)) return ALLOW;

        if (!handCards(state, actor).includes(cardId)) {
          return { ok: false, reason: 'play from your hand' };
        }
        const led = suitLed(state, TRICK_SIZE);
        return { ok: false, reason: led ? `you must follow ${led}` : 'you cannot play that' };
      }

      default:
        // Administering the table and handling your own cards are not moves in
        // the game, and are read from one shared list rather than restated as
        // cases per stage -- which is how 7-8 came to refuse the redeal
        // intents as "not part of this game".
        return TABLE_INTENTS.includes(intent.type) || HANDLING.includes(intent.type)
          ? ALLOW
          : { ok: false, reason: 'not part of this game' };
    }
  },

  after(state: GameState, event: GameEvent): EventBody[] {
    if (state.phase !== 'playing') return [];

    // Trump has been named: the rest of the deal goes out, three each and then
    // two, and play begins.
    if (event.type === 'chosen' && stageOf(state) === 'calling') {
      const stock = state.zones[STOCK_ZONE]?.cards ?? [];
      const placements: CardPlacement[] = [];
      const dealt = new Map<PlayerId, number>(
        state.inPlay.map((id) => [id, handCards(state, id).length]),
      );
      let next = 0;

      for (const size of LATER_BATCHES) {
        for (const playerId of state.inPlay) {
          for (let i = 0; i < size; i++) {
            const cardId = stock[next++];
            if (!cardId) continue;
            const at = dealt.get(playerId) ?? 0;
            placements.push({ cardId, toZone: `hand:${playerId}`, toIndex: at });
            dealt.set(playerId, at + 1);
          }
        }
      }

      return [
        { type: 'gameDataSet', key: 'trump', value: event.option },
        { type: 'gameDataSet', key: 'stage', value: 'playing' },
        { type: 'cardsMoved', placements },
      ];
    }

    // The winner has picked up their trick: face down into their pile, where it
    // stops being anybody's business what was in it.
    if (event.type === 'chosen' && event.option === TAKE) {
      const cards = trickCards(state);
      if (cards.length !== TRICK_SIZE) return [];
      const pile = `pile:${event.by}`;
      const base = state.zones[pile]?.cards.length ?? 0;
      return [
        {
          type: 'cardsMoved',
          placements: cards.map((cardId, index) => ({ cardId, toZone: pile, toIndex: base + index })),
        },
        { type: 'cardsFlipped', flips: cards.map((cardId) => ({ cardId, faceUp: false })) },
      ];
    }

    if (event.type !== 'cardsMoved') return [];

    // A collected trick may have been the last one.
    if (event.placements.some((placement) => state.zones[placement.toZone]?.kind === 'pile')) {
      const taken = state.inPlay.reduce((total, id) => total + tricksTaken(state, id), 0);
      return taken >= TRICKS_PER_ROUND ? [finalResult(state)] : [];
    }

    if (!event.placements.some((placement) => placement.toZone === TRICK_ZONE)) return [];

    const player = event.actor;
    const trump = trumpOf(state);
    if (!player || !trump) return [];

    const inTrick = trickCards(state);
    const turns = order(state);

    // Everyone has played: the trick is decided, and the cards stay where they
    // are until its winner takes them.
    if (inTrick.length === TRICK_SIZE) {
      const winner = trickWinner(state, inTrick, player, turns, trump);
      return winner ? [{ type: 'turnSet', playerId: winner }] : [];
    }

    // Otherwise it travels on round the table.
    const at = turns.indexOf(player);
    if (at < 0) return [];
    return [{ type: 'turnSet', playerId: turns[(at + 1) % turns.length]! }];
  },

  legalCards,

  /** Every play goes to the same place: the trick in the middle. */
  destinationsFor(state: GameState, playerId: PlayerId, cardId: CardId): ZoneId[] {
    return legalCards(state, playerId).includes(cardId) ? [TRICK_ZONE] : [];
  },

  scoreboard(state: GameState): Score[] {
    const players = new Set<PlayerId>(state.seatOrder);
    for (const round of state.match.played) {
      for (const playerId of Object.keys(round.scores)) players.add(playerId);
    }
    return [...players]
      .map((playerId) => ({
        playerId,
        label: 'against quota',
        value: state.match.played.reduce((total, round) => total + (round.scores[playerId] ?? 0), 0),
      }))
      .sort((a, b) => b.value - a.value);
  },

  roundSummary(state: GameState): string {
    const round = state.match.played.at(-1);
    if (!round) return 'Round over';

    const name = (id: PlayerId): string => state.players[id]?.name ?? 'Player';
    const parts = Object.entries(round.scores).map(
      ([playerId, value]) => `${name(playerId)} ${value > 0 ? `+${value}` : value === 0 ? 'met it' : value}`,
    );
    return parts.join(' · ');
  },
};

/**
 * The result, as a signed distance from each quota.
 *
 * Unlike 7-8 -- where the quotas are complementary and exactly one player can
 * be over -- three quotas over ten tricks means players can miss in both
 * directions at once, so falling short has to be able to read as a negative
 * number rather than as nothing.
 */
function finalResult(state: GameState): EventBody {
  const scores: Record<PlayerId, number> = {};
  for (const playerId of state.inPlay) {
    scores[playerId] = tricksTaken(state, playerId) - quotaFor(state, playerId);
  }

  const rankings = [...state.inPlay].sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
  return { type: 'gameEnded', rankings, scores };
}
