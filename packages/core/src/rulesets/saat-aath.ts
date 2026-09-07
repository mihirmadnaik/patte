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
import { TABLE_INTENTS, type EventBody, type GameEvent, type Intent } from '../intents.js';
import type {
  Card,
  CardId,
  GameState,
  PlayerId,
  Rank,
  Suit,
  Zone,
  ZoneId,
} from '../state.js';
import {
  ALLOW,
  type Ruleset,
  type Score,
  type SetupContext,
  type SetupSpec,
  type Verdict,
} from './types.js';

/** Strongest first. The seven exists only in hearts and spades. */
const RANKING: readonly Rank[] = ['A', 'K', 'Q', 'J', '10', '9', '8', '7'] as const;
const SUITS: readonly Suit[] = ['S', 'H', 'D', 'C'] as const;
/** The order a hand is grouped in when sorted: the two reds kept apart. */
const HAND_SUITS: readonly Suit[] = ['S', 'H', 'C', 'D'] as const;
/** Touching your own cards: never a move, so never the ruleset's to refuse. */
const HANDLING: readonly Intent['type'][] = ['grab', 'release', 'peek'];
/**
 * Suits in words, for the things this ruleset says out loud.
 *
 * User-facing text belongs to the ruleset -- it already owns its name, its
 * blurb and how its scores read -- so a suit it needs to announce is spelled
 * here rather than translated back by whoever displays it.
 */
const SUIT_LABEL: Record<Suit, string> = {
  S: '♠ spades',
  H: '♥ hearts',
  D: '♦ diamonds',
  C: '♣ clubs',
};

/** Every seven except the two the pack keeps. */
const DROPPED_SEVENS = ['C7', 'D7'] as const;

export const TRICK_ZONE: ZoneId = 'trick';
const TRICKS_PER_ROUND = 15;
const HAND_SIZE = 5;
const STACKS = 5;
/** The option value for picking up a won trick. */
export const TAKE = 'take';

export const DEALER_QUOTA = 7;
export const CALLER_QUOTA = 8;

export function stackZoneId(playerId: PlayerId, index: number): ZoneId {
  return `stack:${playerId}:${index}`;
}

export function pileZoneId(playerId: PlayerId): ZoneId {
  return `pile:${playerId}`;
}

// --- card strength ---------------------------------------------------------

/** Position in the ranking; lower is stronger. Ace is 0. */
function rankOrder(rank: Rank): number {
  const at = RANKING.indexOf(rank);
  return at === -1 ? RANKING.length : at;
}

/**
 * Whether `challenger` beats `leader`, given what was led and what is trump.
 *
 * Trump beats non-trump; otherwise only a card of the led suit can win, and
 * between two cards of one suit the higher rank takes it. That is the entire
 * rule -- no exceptions, which is what dropping the super-trumps buys.
 */
export function beats(challenger: Card, leader: Card, led: Suit, trump: Suit): boolean {
  const a = challenger.face?.suit;
  const b = leader.face?.suit;
  if (!a || !b || !challenger.face || !leader.face) return false;

  const aTrump = a === trump;
  const bTrump = b === trump;
  if (aTrump !== bTrump) return aTrump;

  // Same category now: either both trumps or neither. A card off-suit and
  // off-trump cannot win whatever its rank.
  if (!aTrump && a !== led) return false;
  if (!aTrump && b !== led) return true;

  return rankOrder(challenger.face.rank) < rankOrder(leader.face.rank);
}

// --- reading the table -----------------------------------------------------

type Stage = 'calling' | 'playing';

export function stageOf(state: GameState): Stage {
  return state.gameData['stage'] === 'playing' ? 'playing' : 'calling';
}

export function trumpOf(state: GameState): Suit | null {
  const trump = state.gameData['trump'];
  return typeof trump === 'string' && SUITS.includes(trump as Suit) ? (trump as Suit) : null;
}

export function dealerOf(state: GameState): PlayerId | null {
  const dealer = state.gameData['dealer'];
  return typeof dealer === 'string' ? dealer : null;
}

export function callerOf(state: GameState): PlayerId | null {
  const dealer = dealerOf(state);
  return state.inPlay.find((id) => id !== dealer) ?? null;
}

/** How many tricks a player has taken: two cards to a trick. */
export function tricksWon(state: GameState, playerId: PlayerId): number {
  return Math.floor((state.zones[pileZoneId(playerId)]?.cards.length ?? 0) / 2);
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

/**
 * Whoever has won the trick sitting on the table, if one is waiting.
 *
 * A decided trick stays where it is until its winner picks it up. Sweeping it
 * away the instant the second card landed made it vanish before it could be
 * read, and doing it silently on their next lead was worse -- the cards
 * disappeared as a side effect of an unrelated action.
 */
export function trickAwaitingCollection(state: GameState): PlayerId | null {
  if (state.phase !== 'playing' || stageOf(state) !== 'playing') return null;
  if ((state.zones[TRICK_ZONE]?.cards.length ?? 0) !== 2) return null;
  return state.turn;
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

/** The cards currently in the middle, oldest first. */
function trickCards(state: GameState): CardId[] {
  return state.zones[TRICK_ZONE]?.cards ?? [];
}

/**
 * The suit that must be followed, or null when nobody has led yet.
 *
 * A trick holding two cards is a finished one still sitting on the table, so
 * the next card played leads afresh rather than following it.
 */
export function ledSuit(state: GameState): Suit | null {
  const cards = trickCards(state);
  if (cards.length !== 1) return null;
  return state.cards[cards[0]!]?.face?.suit ?? null;
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

function pileZone(playerId: PlayerId): Zone {
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

function trickZone(): Zone {
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

  inlineChoice(state: GameState, playerId: PlayerId): { label: string; option: string } | null {
    return trickAwaitingCollection(state) === playerId
      ? { label: 'Take the trick', option: TAKE }
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
        if (!SUITS.includes(intent.option as Suit)) return { ok: false, reason: 'pick a suit' };
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

      const winner = beats(reply, lead, led, trump) ? player : opponent;
      follow.push({ type: 'turnSet', playerId: winner });
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
