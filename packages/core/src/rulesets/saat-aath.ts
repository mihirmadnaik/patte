/**
 * 7-8 (Saat-Aath) — a two-player trick-taking game from Maharashtra.
 *
 * Thirty cards, fifteen tricks, and complementary quotas: the non-dealer names
 * trump and must take eight, the dealer must take seven. Because 7 + 8 is
 * exactly the number of tricks, the whole result is described by one number --
 * the dealer's count. Seven exactly is a draw; anything else means precisely
 * one player exceeded their quota, by exactly the margin the other fell short.
 *
 * Each player holds five cards and has five two-card stacks in front of them:
 * a face-up card with an unknown one beneath. Playing the top card turns the
 * buried one over, so fifteen cards are available to each player but only ten
 * are ever visible at once.
 *
 * House rule, deliberately different from the published game: **there are no
 * super-trumps.** The seven of hearts and seven of spades are ordinary low
 * cards of their suits rather than big and small jokers, which makes the ace
 * of the called trump the highest card in the game and turns card comparison
 * into a plain two-key sort with no special cases.
 */

import { buildDeck, shuffled, type Rng } from '../deck.js';
import { handZone } from './freeplay.js';
import { TABLE_INTENTS, type EventBody, type GameEvent, type Intent } from '../intents.js';
import type { CardId, GameState, PlayerId, Suit, Zone, ZoneId } from '../state.js';
import {
  DROPPED_SEVENS,
  HAND_SUITS,
  SHORT_PACK_RANKING as RANKING,
  TRUMP_SUITS,
  SUIT_LABEL,
  TAKE,
  TRICK_ZONE,
  awaitingCollection,
  beats,
  pileZone,
  pileZoneId,
  stageOf,
  suitLed,
  trickCards,
  trickWinner,
  trickZone,
  trumpOf,
  dealerOf,
  pileTricks,
} from './tricks.js';
import {
  ALLOW,
  type Ruleset,
  type Score,
  type SetupContext,
  type StandingsRow,
  type SetupSpec,
  type Verdict,
} from './types.js';

/** Touching your own cards: never a move, so never the ruleset's to refuse. */
const HANDLING: readonly Intent['type'][] = ['grab', 'release', 'peek'];

const TRICKS_PER_ROUND = 15;
const HAND_SIZE = 5;
const STACKS = 5;
/** Two players, so two cards to a trick. */
const TRICK_SIZE = 2;

export const DEALER_QUOTA = 7;
export const CALLER_QUOTA = 8;

export function stackZoneId(playerId: PlayerId, index: number): ZoneId {
  return `stack:${playerId}:${index}`;
}

// --- reading the table -----------------------------------------------------

export function callerOf(state: GameState): PlayerId | null {
  const dealer = dealerOf(state);
  return state.inPlay.find((id) => id !== dealer) ?? null;
}

/** How many tricks a player has taken: two cards to a trick. */
export function tricksWon(state: GameState, playerId: PlayerId): number {
  return pileTricks(state, playerId, TRICK_SIZE);
}

/**
 * Tricks a player can count on, including one they have won but not yet
 * gathered.
 *
 * A decided trick sits on the table until the winner leads again, which keeps
 * it readable -- but it means the pile has not caught up yet. Showing the
 * uncollected trick as nobody's would tell the player they are a trick worse
 * off than they are.
 */
export function tricksCredited(state: GameState, playerId: PlayerId): number {
  return tricksWon(state, playerId) + (trickAwaitingCollection(state) === playerId ? 1 : 0);
}

/** Whoever has won the trick sitting on the table, if one is waiting. */
export function trickAwaitingCollection(state: GameState): PlayerId | null {
  return awaitingCollection(state, TRICK_SIZE);
}

export function quotaFor(state: GameState, playerId: PlayerId): number {
  return playerId === dealerOf(state) ? DEALER_QUOTA : CALLER_QUOTA;
}

/** The cards a player could reach right now: their hand, plus each stack top. */
export function availableCards(state: GameState, playerId: PlayerId): CardId[] {
  const hand = state.zones[`hand:${playerId}`]?.cards ?? [];
  const tops: CardId[] = [];
  for (let i = 0; i < STACKS; i++) {
    const stack = state.zones[stackZoneId(playerId, i)];
    // The top of a stack is its last card; anything beneath is face down.
    const top = stack?.cards.at(-1);
    if (top && state.cards[top]?.faceUp) tops.push(top);
  }
  return [...hand, ...tops];
}

/** The suit that must be followed, or null when nobody has led yet. */
export function ledSuit(state: GameState): Suit | null {
  return suitLed(state, TRICK_SIZE);
}

/**
 * Not exported: reach it through `saatAath.legalCards`, the same way the
 * client does. Every ruleset has a function by this name and only one of them
 * can own the bare word.
 */
function legalCards(state: GameState, playerId: PlayerId): CardId[] {
  if (state.phase !== 'playing' || stageOf(state) !== 'playing') return [];
  if (state.turn !== playerId) return [];
  // A decided trick has to be picked up before anything may be played onto
  // the next one. Saying otherwise here would have the client light up cards
  // the engine is about to refuse -- and, now that a card's legality is what
  // puts a one-tap play button on it, offer to play them.
  if (trickAwaitingCollection(state) !== null) return [];

  const available = availableCards(state, playerId);
  const led = ledSuit(state);
  if (!led) return available;

  // Follow suit if you can, across hand and stack tops alike.
  const following = available.filter((id) => state.cards[id]?.face?.suit === led);
  return following.length > 0 ? following : available;
}

// --- setup -----------------------------------------------------------------

function stackZone(playerId: PlayerId, index: number): Zone {
  return {
    id: stackZoneId(playerId, index),
    kind: 'stack',
    owner: playerId,
    layout: 'stack',
    // 'none', not 'owner': the buried card is unknown to *both* players, which
    // is the whole point of dealing it face down under another card.
    faceDownVisibleTo: 'none',
    openToOthers: false,
    cards: [],
  };
}

export const saatAath: Ruleset = {
  id: 'saat-aath',
  name: 'सात-आठ',
  blurb: 'Two players, thirty cards. Call trump and take your quota of tricks — eight, or seven.',
  // Strongest first, which is `RANKING` -- the same order the game itself
  // ranks cards in, so a sorted hand reads as "what can beat what".
  handOrder: { suits: HAND_SUITS, ranks: RANKING },
  minPlayers: 2,
  maxPlayers: 2,
  autoStart: false,
  scoreDirection: 'high',
  scoreNote: 'You score how far past your quota you got. Highest total leads.',

  howToPlay: {
    goal: 'Take your quota of the fifteen tricks: eight if you called trump, seven if you dealt.',
    rules: [
      'Thirty cards: nothing below a seven, and only the seven of hearts and the seven of spades.',
      'You hold five cards, and five stacks of two sit in front of you — a face-up card with an unknown one underneath. So fifteen cards are yours, but only ten are ever visible.',
      'Whoever did not deal names trump, having seen only their five hand cards. Then the stack tops are turned up and they lead.',
      'Follow the suit that was led if you can, from your hand or from the top of a stack. The highest trump takes the trick; with no trump in it, the highest card of the suit led.',
      'Playing the top of a stack turns over the card beneath it, so what you have available changes as you go.',
      'The quotas add up to fifteen exactly, so one of you beats yours by however much the other falls short. Seven each is a draw.',
    ],
  },
  // No passing: you always hold something you are allowed to play.

  /**
   * Trump, said out loud to the player who did not choose it.
   *
   * The caller looked at five cards and picked; the dealer finds out. Until
   * this, that news arrived only as a suit quietly appearing in the toolbar,
   * which is no way to learn the single fact that governs the whole hand.
   */
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
      prompt: 'You have five cards. Name a trump suit — then the table cards are turned up and you lead.',
    };
  },

  standings(state: GameState): StandingsRow[] | null {
    if (state.phase !== 'playing') return null;
    const dealer = dealerOf(state);
    return state.inPlay.map((playerId) => ({
      playerId,
      won: tricksCredited(state, playerId),
      quota: quotaFor(state, playerId),
      // Whose deal it is decides who has the easier quota, so it is worth
      // saying on a table of two where the roles swap every round.
      ...(playerId === dealer ? { note: 'deals' } : {}),
    }));
  },

  inlineChoice(
    state: GameState,
    playerId: PlayerId,
  ): { label: string; option: string; note?: string } | null {
    return trickAwaitingCollection(state) === playerId
      ? { label: 'Take the trick', option: TAKE, note: 'You won that trick' }
      : null;
  },

  awaitingChoice(state: GameState): PlayerId | null {
    if (state.phase !== 'playing') return null;
    if (stageOf(state) === 'calling') return callerOf(state);
    return trickAwaitingCollection(state);
  },

  setup({ players, rng, match, previous }: SetupContext): SetupSpec {
    // The deal alternates every time cards go out, so the harder eight-trick
    // quota changes hands each game rather than punishing whoever sat down
    // second.
    //
    // Taken from the previous *deal* rather than from the number of scored
    // rounds. Those differ whenever a round ends without a score -- a redeal,
    // an abandoned hand -- and reading the round count handed the trump call
    // back to the player who had just made it.
    const last = typeof previous['dealer'] === 'string' ? previous['dealer'] : null;
    const dealer =
      (last ? players.find((id) => id !== last) : players[match.played.length % players.length]) ??
      players[0]!;
    const caller = players.find((id) => id !== dealer) ?? players[0]!;
    const order = [caller, dealer]; // the caller is dealt to first, and leads

    const zones: Zone[] = [trickZone()];
    for (const playerId of players) {
      zones.push(handZone(playerId), pileZone(playerId));
      for (let i = 0; i < STACKS; i++) zones.push(stackZone(playerId, i));
    }

    const cards = buildDeck('deck', { ranks: RANKING, exclude: DROPPED_SEVENS });
    const byId = new Map(cards.map((card) => [card.id, card]));
    const shoe = shuffled(
      cards.map((card) => card.id),
      rng,
    );
    let next = 0;

    const place = (cardId: CardId, zone: Zone, faceUp: boolean): void => {
      const card = byId.get(cardId);
      if (!card) return;
      zone.cards.push(cardId);
      card.zone = zone.id;
      card.faceUp = faceUp;
    };

    const zoneOf = (id: ZoneId): Zone => zones.find((zone) => zone.id === id)!;

    // Five each, alternating, caller first.
    for (let i = 0; i < HAND_SIZE; i++) {
      for (const playerId of order) place(shoe[next++]!, zoneOf(`hand:${playerId}`), false);
    }

    // Then the stacks: the buried card first, the one that will show on top.
    //
    // The published rules deal these only after trump is called. Dealing them
    // now but leaving every one face down is information-equivalent -- the
    // caller still decides on five cards and nothing else -- and it keeps this
    // function the only place randomness is consulted, which is what lets the
    // event log be replayed exactly.
    for (const playerId of order) {
      for (let i = 0; i < STACKS; i++) {
        const stack = zoneOf(stackZoneId(playerId, i));
        place(shoe[next++]!, stack, false);
        place(shoe[next++]!, stack, false);
      }
    }

    return {
      zones,
      cards,
      options: { enforceTurnOrder: true, handsArePrivate: true, anyoneMayShuffle: false },
      firstTurn: caller,
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
        if (actor !== callerOf(state)) return { ok: false, reason: 'the other player calls trump' };
        if (!TRUMP_SUITS.includes(intent.option as Suit)) return { ok: false, reason: 'pick a suit' };
        return ALLOW;
      }
      return TABLE_INTENTS.includes(intent.type) || HANDLING.includes(intent.type)
        ? ALLOW
        : { ok: false, reason: 'waiting for trump to be called' };
    }

    // A decided trick has to be picked up before play continues.
    const waiting = trickAwaitingCollection(state);
    if (waiting) {
      if (intent.type === 'choose') {
        if (actor !== waiting) return { ok: false, reason: 'that trick is not yours' };
        return intent.option === TAKE
          ? ALLOW
          : { ok: false, reason: 'there is a trick to take first' };
      }
      if (intent.type === 'move') {
        return {
          ok: false,
          reason: actor === waiting ? 'take the trick first' : 'wait for the trick to be taken',
        };
      }
    }

    switch (intent.type) {
      case 'move': {
        // Rearranging your own hand is fine; fetching a card back out of a
        // trick you have taken is not.
        if (intent.toZone === `hand:${actor}`) {
          return intent.cardIds.every((id) => state.cards[id]?.zone === `hand:${actor}`)
            ? ALLOW
            : { ok: false, reason: 'a card that is played stays played' };
        }

        if (state.turn !== actor) return { ok: false, reason: 'wait for your turn' };
        if (intent.toZone !== TRICK_ZONE) return { ok: false, reason: 'play cards to the middle' };
        if (intent.cardIds.length !== 1) return { ok: false, reason: 'play one card at a time' };

        const cardId = intent.cardIds[0]!;
        const legal = legalCards(state, actor);
        if (legal.includes(cardId)) return ALLOW;

        if (!availableCards(state, actor).includes(cardId)) {
          return { ok: false, reason: 'play from your hand or the top of a stack' };
        }
        const led = ledSuit(state);
        return { ok: false, reason: led ? `you must follow ${led}` : 'you cannot play that' };
      }

      default:
        // Handling your own cards, and administering the table, are not moves
        // in the game -- so they are allowed here by the same list the other
        // stages use rather than by a case for each. Spelled out stage by
        // stage, this switch was the one that forgot the redeal intents and
        // refused them as "not part of this game".
        return TABLE_INTENTS.includes(intent.type) || HANDLING.includes(intent.type)
          ? ALLOW
          : { ok: false, reason: 'not part of this game' };
    }
  },

  after(state: GameState, event: GameEvent): EventBody[] {
    if (state.phase !== 'playing') return [];

    // Trump has been named: turn up the ten stack tops and begin.
    if (event.type === 'chosen' && stageOf(state) === 'calling') {
      const tops: CardId[] = [];
      for (const playerId of state.inPlay) {
        for (let i = 0; i < STACKS; i++) {
          const top = state.zones[stackZoneId(playerId, i)]?.cards.at(-1);
          if (top) tops.push(top);
        }
      }
      return [
        { type: 'gameDataSet', key: 'trump', value: event.option },
        { type: 'gameDataSet', key: 'stage', value: 'playing' },
        { type: 'cardsFlipped', flips: tops.map((cardId) => ({ cardId, faceUp: true })) },
      ];
    }

    // The winner has picked up their trick: face down into their pile, where
    // it stops being anybody's business what was in it.
    if (event.type === 'chosen' && event.option === TAKE) {
      const cards = trickCards(state);
      if (cards.length !== 2) return [];
      return [
        collect(state, [cards[0]!, cards[1]!], event.by),
        { type: 'cardsFlipped', flips: cards.map((cardId) => ({ cardId, faceUp: false })) },
      ];
    }

    if (event.type !== 'cardsMoved') return [];

    // A collected trick may have been the last one.
    const intoPile = event.placements.some(
      (placement) => state.zones[placement.toZone]?.kind === 'pile',
    );
    if (intoPile) {
      const taken = state.inPlay.reduce((total, id) => total + tricksWon(state, id), 0);
      return taken >= TRICKS_PER_ROUND ? [finalResult(state)] : [];
    }

    if (!event.placements.some((placement) => placement.toZone === TRICK_ZONE)) return [];

    const follow: EventBody[] = [];

    // A card played off a stack uncovers the one beneath it. The played card
    // has already left its zone, so rather than track where it came from,
    // look for the stack that now shows a face-down card on top -- an
    // invariant that only the play just made can break.
    for (const zone of Object.values(state.zones)) {
      if (zone.kind !== 'stack') continue;
      const exposed = zone.cards.at(-1);
      if (exposed && !state.cards[exposed]?.faceUp) {
        follow.push({ type: 'cardsFlipped', flips: [{ cardId: exposed, faceUp: true }] });
      }
    }

    const player = event.actor;
    const opponent = state.inPlay.find((id) => id !== player) ?? null;
    const trump = trumpOf(state);
    if (!player || !opponent || !trump) return follow;

    const inTrick = trickCards(state);

    // Two down: the trick is decided. `player` replied, so the other one led.
    // The cards stay where they are until the winner takes them.
    if (inTrick.length === 2) {
      const lead = state.cards[inTrick[0]!];
      const reply = state.cards[inTrick[1]!];
      const led = lead?.face?.suit;
      if (!lead || !reply || !led) return follow;

      const winner = trickWinner(state, inTrick, player, [opponent, player], trump);
      if (winner) follow.push({ type: 'turnSet', playerId: winner });
      return follow;
    }

    // One down: somebody has led and the other must answer.
    if (inTrick.length === 1) follow.push({ type: 'turnSet', playerId: opponent });
    return follow;
  },

  legalCards,

  /**
   * Every play in 7-8 goes to the same place: the trick in the middle.
   *
   * True whether the card comes from your hand or off the top of one of your
   * stacks, which is why this asks about the card rather than about the zone
   * it is sitting in.
   */
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
        label: 'over quota',
        value: state.match.played.reduce((total, round) => total + (round.scores[playerId] ?? 0), 0),
      }))
      .sort((a, b) => b.value - a.value);
  },

  roundSummary(state: GameState): string {
    const round = state.match.played.at(-1);
    if (!round) return 'Round over';

    const winner = Object.entries(round.scores).find(([, value]) => value > 0);
    if (!winner) return 'A draw — both quotas met exactly';

    const [playerId, margin] = winner;
    const name = state.players[playerId]?.name ?? 'Player';
    return `${name} beat their quota by ${margin}`;
  },
};

/** Move a finished trick into the winner's pile. */
function collect(state: GameState, cards: [CardId, CardId], winner: PlayerId): EventBody {
  const pile = pileZoneId(winner);
  const base = state.zones[pile]?.cards.length ?? 0;
  return {
    type: 'cardsMoved',
    placements: cards.map((cardId, index) => ({ cardId, toZone: pile, toIndex: base + index })),
  };
}

function finalResult(state: GameState): EventBody {
  const dealer = dealerOf(state);
  const scores: Record<PlayerId, number> = {};

  for (const playerId of state.inPlay) {
    const quota = playerId === dealer ? DEALER_QUOTA : CALLER_QUOTA;
    scores[playerId] = Math.max(0, tricksWon(state, playerId) - quota);
  }

  const rankings = [...state.inPlay].sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
  return { type: 'gameEnded', rankings, scores };
}
