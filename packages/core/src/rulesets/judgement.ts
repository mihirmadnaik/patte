/**
 * जजमेंट (Judgement) — call your tricks, then take exactly that many.
 *
 * Known elsewhere as Oh Hell, Kachuful, Blackout and Nomination Whist. Three
 * to ten players, the full fifty-two-card pack, ace high, and no partnerships:
 * everybody is on their own.
 *
 * Three things make it its own game rather than another trick-taker.
 *
 * **The hand shrinks, and then grows back.** The first round deals as many
 * cards as the pack will divide into the table -- thirteen each for four
 * players, five each for ten -- and every round after it deals one fewer,
 * down to a single card. Then it climbs back: one card again, two, and on up
 * until the hand is the size it started at, and the match is over. The
 * single-card round is played at both ends of the turn, so the two halves
 * mirror each other and a match is twice the opening hand in rounds. Its
 * length is therefore the seat count's to decide, which is why nobody is
 * asked. The cards the deal cannot use are set aside out of play -- most of
 * them, at the turn.
 *
 * **Trump is not chosen.** It runs on a five-step cycle fixed before a card is
 * dealt -- spades, hearts, clubs, diamonds, and then a round with no trump at
 * all, decided on the led suit alone. No player ever names it, which is why it
 * has to be announced: a game where somebody picks trump tells everyone by the
 * picking.
 *
 * **The quota is yours, and it is exact.** You call how many tricks you will
 * take, and you score only by taking precisely that many. One over scores the
 * same as one under, which is nothing -- so a player who has made their call
 * spends the rest of the hand trying to lose, and that is the whole game.
 *
 * The dealer is hooked: speaking last, they may not call the number that would
 * make the calls add up to the hand exactly. Somebody therefore always fails,
 * which is the point of it.
 */

import { buildDeck, shuffled } from '../deck.js';
import {
  TABLE_INTENTS,
  type EventBody,
  type GameEvent,
  type Intent,
} from '../intents.js';
import type { Card, CardId, GameState, PlayerId, Suit, Zone, ZoneId } from '../state.js';
import { handZone } from './freeplay.js';
import {
  FULL_PACK_RANKING,
  HAND_SUITS,
  SUIT_LABEL,
  TAKE,
  TRICK_ZONE,
  awaitingCollection,
  dealerOf,
  pileTricks,
  pileZone,
  suitLed,
  trickCards,
  trickWinner,
  trickZone,
  trumpOf,
} from './tricks.js';
import {
  ALLOW,
  type AuctionCall,
  type Ruleset,
  type Score,
  type SetupContext,
  type SetupSpec,
  type StandingsRow,
  type Verdict,
} from './types.js';

/** Touching your own cards: never a move, so never the ruleset's to refuse. */
const HANDLING: readonly Intent['type'][] = ['grab', 'release', 'peek'];

/** The whole pack, which is what decides how long a match is. */
const PACK = 52;

/**
 * The trump, by round, on a five-step cycle.
 *
 * Spades, hearts, clubs, diamonds -- which is `HAND_SUITS`, the order a hand
 * is already sorted into -- and then `null`, a round with no trump in it. The
 * engine has understood a trumpless hand since लॅडीस needed one, so the fifth
 * round needs no machinery, only saying out loud.
 */
const TRUMP_CYCLE: readonly (Suit | null)[] = [...HAND_SUITS, null];

/** A call is sent as `choose` with this prefix and the number. */
const CALL_PREFIX = 'call:';

// --- reading the table -----------------------------------------------------
//
// None of this is exported, for the same reason as in लॅडीस: every ruleset has
// a `legalCards` and a `handSize`, and only one of them can own the bare word.
// The way in from outside is this ruleset's own hooks.

type Stage = 'bidding' | 'playing';

function stage(state: GameState): Stage {
  return state.gameData['stage'] === 'playing' ? 'playing' : 'bidding';
}

function numberAt(state: GameState, key: string): number {
  const value = state.gameData[key];
  return typeof value === 'number' ? value : 0;
}

function nameOf(state: GameState, playerId: PlayerId | null): string {
  return (playerId && state.players[playerId]?.name) || 'Another player';
}

/** How many cards everybody was dealt, which is also how many tricks there are. */
function handSizeOf(state: GameState): number {
  return Math.max(numberAt(state, 'handSize'), 1);
}

/** Which round of the ladder this is, counting from one. */
function roundOf(state: GameState): number {
  return Math.max(numberAt(state, 'round'), 1);
}

/** As many cards each as the pack divides into the table. */
function openingHand(seats: number): number {
  return Math.max(Math.floor(PACK / Math.max(seats, 1)), 1);
}

/**
 * How many cards a given round deals: down to one, and back up again.
 *
 * The hand shortens by a card a round until it reaches one, and then
 * lengthens by a card a round until it is back where it started. The
 * single-card round is played *twice*, once at the bottom of the descent and
 * once at the foot of the climb, which is what makes the two halves mirror
 * each other exactly -- and is why a match is `2 * opening` rounds rather
 * than one short of it.
 *
 * Rounds count from one. Past the top of the ladder it stays at the top: a
 * bonus round somebody deals after the match is over is a full hand, not a
 * fourteenth card that does not exist.
 */
function handSizeFor(opening: number, round: number): number {
  const descending = opening - round + 1;
  if (descending >= 1) return descending;
  return Math.min(round - opening, opening);
}

/**
 * What this player called, or null if they have not spoken.
 *
 * Nought is a call, so "absent" and "zero" are different answers and cannot
 * share a representation -- which is exactly the bug a `numberAt` defaulting
 * to zero would have introduced.
 */
function callOf(state: GameState, playerId: PlayerId): number | null {
  const value = state.gameData[`bid:${playerId}`];
  return typeof value === 'number' ? value : null;
}

/** Whose turn it is to call: the first seat that has not. */
function nextCaller(state: GameState): PlayerId | null {
  return state.inPlay.find((id) => callOf(state, id) === null) ?? null;
}

/** What has been called so far, in total. */
function calledSoFar(state: GameState): number {
  return state.inPlay.reduce((total, id) => total + (callOf(state, id) ?? 0), 0);
}

/**
 * The number this player may not call, if they are the one being hooked.
 *
 * The hook falls on whoever speaks last -- the dealer, since the order starts
 * at their left -- and only on them: it is a rule about the table's total, and
 * nobody but the last to speak knows what the total will be. Null when the
 * completing number is out of range anyway, which happens whenever the calls
 * already made add up to more than the hand.
 */
function hookedFor(state: GameState, caller: PlayerId): number | null {
  const others = state.inPlay.filter((id) => id !== caller);
  if (others.some((id) => callOf(state, id) === null)) return null;
  const gap = handSizeOf(state) - calledSoFar(state);
  return gap >= 0 ? gap : null;
}

/**
 * Every number there is to call: none of the tricks, up to all of them.
 *
 * Deliberately whole, hook and all. A ladder with the hooked number quietly
 * missing is a ladder that counts 0, 2, 3 -- so a player stepping up once
 * from nothing lands on two, having asked for one, and reasonably reports
 * that the wrong number was registered. What the dealer may not call is said
 * out loud instead, by `hookedFor` and the note beside the stepper.
 */
function ladderFor(state: GameState): number[] {
  const ladder: number[] = [];
  for (let n = 0; n <= handSizeOf(state); n++) ladder.push(n);
  return ladder;
}

function parseCall(option: string): number | null {
  if (!option.startsWith(CALL_PREFIX)) return null;
  const value = Number(option.slice(CALL_PREFIX.length));
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function handCards(state: GameState, playerId: PlayerId): CardId[] {
  return state.zones[`hand:${playerId}`]?.cards ?? [];
}

/** One card per player to a trick. */
function trickSize(state: GameState): number {
  return Math.max(state.inPlay.length, 1);
}

function tricksTaken(state: GameState, playerId: PlayerId): number {
  return pileTricks(state, playerId, trickSize(state));
}

/**
 * Tricks a player can count on, including one they have won but not gathered.
 *
 * The readout must never say somebody is a trick worse off than they are --
 * and in this game it matters more than usual, because the number it is being
 * compared against is one the player chose and may be dreading reaching.
 */
function tricksStanding(state: GameState, playerId: PlayerId): number {
  return tricksTaken(state, playerId) + (awaitingCollection(state, trickSize(state)) === playerId ? 1 : 0);
}

/** Whether the cards have all been played and every trick gathered. */
function handFinished(state: GameState): boolean {
  if (trickCards(state).length > 0) return false;
  return state.inPlay.every((id) => handCards(state, id).length === 0);
}

/** What a result is worth: ten a trick, five for a called nothing, else nothing. */
function scoreFor(called: number, taken: number): number {
  if (taken !== called) return 0;
  return called === 0 ? 5 : called * 10;
}

/** The calls so far, read out. */
function callsInWords(state: GameState): string {
  const spoken = state.inPlay.filter((id) => callOf(state, id) !== null);
  if (spoken.length === 0) return '';
  return spoken.map((id) => `${nameOf(state, id)} ${callOf(state, id)}`).join(', ');
}

function legalCards(state: GameState, playerId: PlayerId): CardId[] {
  if (state.phase !== 'playing') return [];
  // Nothing is played during the calling.
  if (stage(state) !== 'playing') return [];
  if (state.turn !== playerId) return [];
  // A decided trick has to be picked up before anything may be played onto
  // the next one, or the client lights up cards the engine is about to refuse.
  if (awaitingCollection(state, trickSize(state)) !== null) return [];

  const hand = handCards(state, playerId);
  const led = suitLed(state, trickSize(state));
  if (!led) return hand;

  // Follow if you can; otherwise anything, trump included.
  const following = hand.filter((id) => state.cards[id]?.face?.suit === led);
  return following.length > 0 ? following : hand;
}

// --- the ruleset -----------------------------------------------------------

export const judgement: Ruleset = {
  id: 'judgement',
  name: 'जजमेंट',
  blurb: 'Call your tricks exactly. One over is as bad as one under.',
  handOrder: { suits: HAND_SUITS, ranks: FULL_PACK_RANKING },
  minPlayers: 3,
  maxPlayers: 10,
  autoStart: false,
  scoreDirection: 'high',
  scoreNote: 'Ten a trick for a call you hit exactly, five for a called nothing, and nothing at all for a call you miss.',
  // The ladder runs down to one card and back, so its length follows from
  // the seats rather than from anybody's choice.
  fixedLength: true,

  /**
   * How long the match will be, which nobody chose.
   *
   * Said before the deal, when there is no round count on the table to read:
   * `match.rounds` is whatever the room was opened with until the first setup
   * states the real figure.
   */
  lobbyNote(seated: number): string {
    const opening = openingHand(seated);
    return `${opening * 2} rounds — ${opening} cards each down to one, then back up to ${opening}.`;
  },

  howToPlay: {
    goal: 'Take exactly as many tricks as you called — no more, no fewer.',
    rules: [
      'The full fifty-two-card pack, ace high. The first round deals as many cards each as the pack divides into the table; every round after it deals one fewer, down to a single card — and then back up, a card at a time, until the hand is the size it began at. That is the whole match.',
      'The one-card round is played twice, once at the bottom of the way down and once at the foot of the way back up.',
      'The cards left over each round are set aside and nobody plays them. There are more of them the shorter the hand gets, and most of all at the one-card round.',
      'Trump is fixed before the deal and nobody chooses it: spades, then hearts, then clubs, then diamonds, then a round with no trump at all — and round again.',
      'Starting at the dealer\'s left, everybody calls how many of the tricks they will take. Nought is a call, not a pass.',
      'The dealer calls last and may not call the number that would make every call add up to the hand exactly — so somebody always has to fail.',
      'Follow the suit that was led if you can. The highest trump takes the trick; with no trump in it, the highest card of the suit led. Whoever wins it leads the next one.',
      'Take exactly what you called and score ten for each trick of it — five if you called nothing and took nothing. Take one more or one fewer and the round scores you nothing, so a hand can be worth losing on purpose.',
      'The deal moves one seat to the left each round. Highest total at the top of the climb wins.',
    ],
  },

  announce(state: GameState, event: GameEvent): string | { line: string; show?: CardId[] } | null {
    // Trump is nobody's choice here, so nothing about the deal tells the table
    // what it is. Said on the round being written down, which setup does last,
    // so the suit is already in place to be read back.
    if (event.type === 'gameDataSet' && event.key === 'round') {
      const trump = trumpOf(state);
      const cards = handSizeOf(state);
      const hand = cards === 1 ? 'One card each' : `${cards} cards each`;
      return trump
        ? `${hand} — ${SUIT_LABEL[trump]} are trump`
        : `${hand} — no trump this round, highest card of the suit led takes it`;
    }
    return null;
  },

  auction(state: GameState): AuctionCall | null {
    if (state.phase !== 'playing' || stage(state) !== 'bidding') return null;
    const caller = nextCaller(state);
    if (!caller) return null;

    const cards = handSizeOf(state);
    const hooked = hookedFor(state, caller);
    const said = callsInWords(state);
    const tricks = cards === 1 ? 'the one trick' : `the ${cards} tricks`;

    return {
      bidder: caller,
      prompt:
        hooked !== null
          ? `You call last, so the calls must not add up to ${cards} exactly — somebody has to fail.`
          : `How many of ${tricks} will you take? Nought is a call.`,
      standing: said === '' ? null : `${said} · ${calledSoFar(state)} of ${cards} called`,
      stakes: ladderFor(state),
      // The hook: on the ladder, and the one number this player may not say.
      ...(hooked !== null
        ? {
            barred: {
              stake: hooked,
              note: `${hooked} would make the calls add up to ${cards} exactly.`,
            },
          }
        : {}),
      stakePrefix: CALL_PREFIX,
      declareLabel: 'Call',
      stakeLabel: 'Tricks',
      // Nought is a number on the ladder like any other, but "Call · 0" is not
      // a sentence anybody says.
      hold: { stake: 0, label: 'Call nothing' },
      // No pass: every player must name a number, and nought is how you say
      // you want none of them.
      hint: 'Take exactly what you call. One over scores the same as one under.',
    };
  },

  instruction(state: GameState, playerId: PlayerId): string | null {
    if (state.phase !== 'playing') return null;

    if (stage(state) === 'bidding') {
      const caller = nextCaller(state);
      if (!caller || caller === playerId) return null;
      return `${nameOf(state, caller)} is calling`;
    }

    // Worth repeating through the hand: with no trump the whole shape of a
    // trick changes, and there is no glyph in the strip to notice its absence.
    // Short, because the pill is one line on a phone and truncates.
    if (trumpOf(state) === null) return 'No trump — the suit led takes it';
    return null;
  },

  standings(state: GameState): StandingsRow[] | null {
    // On screen from the moment the cards go out, because the calling happens
    // against these numbers and then the whole hand is played against them.
    if (state.phase !== 'playing') return null;
    const dealer = dealerOf(state);

    return state.inPlay.map((playerId) => ({
      playerId,
      won: tricksStanding(state, playerId),
      // A player who has not called yet shows a quota of nought, which reads
      // as what it is: nothing claimed so far.
      quota: callOf(state, playerId) ?? 0,
      exact: true,
      ...(playerId === dealer ? { note: 'deals' } : {}),
    }));
  },

  inlineChoice(
    state: GameState,
    playerId: PlayerId,
  ): { label: string; option: string; note?: string } | null {
    if (awaitingCollection(state, trickSize(state)) === playerId) {
      const called = callOf(state, playerId) ?? 0;
      const after = tricksTaken(state, playerId) + 1;
      return {
        label: 'Take the trick',
        option: TAKE,
        // The one game where winning a trick can be the bad news.
        note: after > called ? 'That puts you past your call' : 'You won that trick',
      };
    }
    return null;
  },

  awaitingChoice(state: GameState): PlayerId | null {
    if (state.phase !== 'playing') return null;
    if (stage(state) === 'bidding') return nextCaller(state);
    return awaitingCollection(state, trickSize(state));
  },

  setup({ players, rng, match, previous, reset }: SetupContext): SetupSpec {
    const seats = [...players];
    const opening = openingHand(seats.length);

    /*
     * Where on the ladder this round is.
     *
     * Carried from the previous *deal* rather than counted off the scored
     * rounds, which is how every game here reads the dealer: the two differ
     * whenever a hand is abandoned, and a redeal must play the same round
     * again rather than skipping a rung of the ladder.
     */
    const carried = reset ? {} : previous;
    const counted = (key: string): number | null =>
      typeof carried[key] === 'number' ? (carried[key] as number) : null;
    /*
     * `nextRound` is written only when a hand is scored, so it is there after
     * a hand that ended and absent after one that was abandoned -- and a
     * redeal must not move along the ladder, because nothing was decided.
     * Falling back to the round just dealt replays that same rung.
     */
    const round = counted('nextRound') ?? counted('round') ?? 1;
    // One carried number, and everything else read off it: the hand size and
    // the trump cannot drift out of step with the round if neither is stored.
    const handSize = handSizeFor(opening, round);
    const trump = TRUMP_CYCLE[(round - 1) % TRUMP_CYCLE.length] ?? null;

    const seated = (id: unknown): PlayerId | null =>
      typeof id === 'string' && seats.includes(id) ? id : null;
    const previousDealer = seated(carried['nextDealer']) ?? seated(carried['dealer']);
    const dealer =
      previousDealer ?? seats[match.played.length % Math.max(seats.length, 1)] ?? seats[0]!;

    // Turn order runs from the dealer's left, who calls first and leads first,
    // round to the dealer, who calls last and is the one hooked.
    const turns: PlayerId[] = [];
    for (let step = 1; step <= seats.length; step++) {
      const at = (seats.indexOf(dealer) + step) % seats.length;
      const playerId = seats[at];
      if (playerId !== undefined) turns.push(playerId);
    }

    const zones: Zone[] = [trickZone()];
    for (const playerId of seats) zones.push(handZone(playerId), pileZone(playerId));
    const zoneOf = (id: ZoneId): Zone => zones.find((zone) => zone.id === id)!;

    /*
     * The pack is shuffled whole and then most of it is thrown away.
     *
     * What the deal cannot use is not put in a stock zone, as the two-stage
     * games do -- it is left out of the returned cards entirely, so those
     * cards do not exist in this game's state at all. That is the strongest
     * form of "set aside out of play": there is no zone holding them for a
     * projection bug to leak, and nothing on screen to explain.
     */
    const pack = buildDeck('deck');
    const byId = new Map(pack.map((card) => [card.id, card]));
    const shoe = shuffled(
      pack.map((card) => card.id),
      rng,
    );

    const cards: Card[] = [];
    let next = 0;
    for (let i = 0; i < handSize; i++) {
      for (const playerId of turns) {
        const card = byId.get(shoe[next++]!);
        if (!card) continue;
        const zone = zoneOf(`hand:${playerId}`);
        zone.cards.push(card.id);
        card.zone = zone.id;
        card.faceUp = false;
        cards.push(card);
      }
    }

    return {
      zones,
      cards,
      options: { handsArePrivate: true, enforceTurnOrder: true },
      firstTurn: turns[0] ?? null,
      inPlay: turns,
      // Down to one and back up, with the single-card hand played at both
      // ends of the turn: twice as many rounds as the opening hand had cards.
      rounds: opening * 2,
      gameData: {
        stage: 'bidding',
        dealer,
        handSize,
        // Trump before round, because the announcement fires on `round` being
        // written and reads the suit back out of the state.
        ...(trump ? { trump } : {}),
        round,
      },
    };
  },

  validate(state: GameState, intent: Intent, actor: PlayerId): Verdict {
    const administering = (): boolean =>
      TABLE_INTENTS.includes(intent.type) || HANDLING.includes(intent.type);

    if (state.phase !== 'playing') {
      return TABLE_INTENTS.includes(intent.type)
        ? ALLOW
        : { ok: false, reason: 'the game is not in play' };
    }

    if (stage(state) === 'bidding') {
      if (intent.type === 'choose') {
        const caller = nextCaller(state);
        if (actor !== caller) return { ok: false, reason: 'it is not your call' };
        const called = parseCall(intent.option);
        if (called === null) return { ok: false, reason: 'call a number of tricks' };
        if (called > handSizeOf(state)) {
          return { ok: false, reason: `there are only ${handSizeOf(state)} tricks` };
        }
        if (called === hookedFor(state, actor)) {
          return {
            ok: false,
            reason: `calling ${called} would make the calls add up to ${handSizeOf(state)} exactly`,
          };
        }
        return ALLOW;
      }
      return administering() ? ALLOW : { ok: false, reason: 'the calling is still going round' };
    }

    // A decided trick has to be picked up before play continues.
    const waiting = awaitingCollection(state, trickSize(state));
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
      case 'choose':
        return { ok: false, reason: 'there is nothing to choose' };

      case 'move': {
        // Rearranging your own hand is fine at any point.
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
        const led = suitLed(state, trickSize(state));
        return { ok: false, reason: led ? `you must follow ${led}` : 'you cannot play that' };
      }

      default:
        // Administering the table and handling your own cards are not moves in
        // the game, and are read from one shared list rather than restated as
        // cases per stage -- which is how 7-8 came to refuse the redeal
        // intents as "not part of this game".
        return administering() ? ALLOW : { ok: false, reason: 'not part of this game' };
    }
  },

  after(state: GameState, event: GameEvent): EventBody[] {
    if (state.phase !== 'playing') return [];

    // --- the calling ------------------------------------------------------
    //
    // `chosen` changes nothing by itself -- the engine does not know what an
    // option means -- so the call is written down here, and play opens when
    // the writing-down shows everybody has spoken.
    if (stage(state) === 'bidding') {
      if (event.type === 'chosen') {
        const called = parseCall(event.option);
        if (called === null) return [];
        return [{ type: 'gameDataSet', key: `bid:${event.by}`, value: called }];
      }

      if (event.type !== 'gameDataSet' || !event.key.startsWith('bid:')) return [];
      if (nextCaller(state) !== null) return [];
      return [
        { type: 'gameDataSet', key: 'stage', value: 'playing' },
        // The dealer's left called first and leads first. The turn has not
        // moved during the calling, but saying so costs nothing and means the
        // lead is stated in one place rather than inherited.
        { type: 'turnSet', playerId: state.inPlay[0] ?? null },
      ];
    }

    // --- a trick, gathered ------------------------------------------------
    if (event.type === 'chosen' && event.option === TAKE) {
      const cards = trickCards(state);
      if (cards.length !== trickSize(state)) return [];
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

    // The last trick of the hand has just been gathered.
    if (
      event.placements.some((placement) => state.zones[placement.toZone]?.kind === 'pile') &&
      handFinished(state)
    ) {
      return handResult(state);
    }

    if (!event.placements.some((placement) => placement.toZone === TRICK_ZONE)) return [];

    const player = event.actor;
    if (!player) return [];

    const inTrick = trickCards(state);
    const turns = [...state.inPlay];
    const size = trickSize(state);

    // Everyone has played: the trick is decided, and the cards stay where they
    // are until its winner takes them.
    if (inTrick.length === size) {
      const winner = trickWinner(state, inTrick, player, turns, trumpOf(state));
      return winner ? [{ type: 'turnSet', playerId: winner }] : [];
    }

    // Otherwise it travels on round the table.
    const seat = turns.indexOf(player);
    if (seat < 0) return [];
    return [{ type: 'turnSet', playerId: turns[(seat + 1) % turns.length]! }];
  },

  legalCards,

  /** Where a card may go: the middle, and only if it is legal there. */
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
        label: 'scored',
        value: state.match.played.reduce((total, round) => total + (round.scores[playerId] ?? 0), 0),
      }))
      .sort((a, b) => b.value - a.value);
  },

  roundSummary(state: GameState): string {
    const round = state.match.played.at(-1);
    if (!round) return 'Round over';

    const made = Object.entries(round.scores)
      .filter(([, value]) => value > 0)
      .map(([playerId]) => state.players[playerId]?.name ?? 'Player');

    if (made.length === 0) return 'Nobody made their call';
    if (made.length === 1) return `${made[0]} made their call`;
    return `${made.slice(0, -1).join(', ')} and ${made.at(-1)} made their calls`;
  },
};

// --- what follows from what just happened ---------------------------------

/**
 * The hand is over: what everybody called against what they took.
 *
 * Unlike every other game here there is nothing to work out about who won --
 * each player is measured against their own number, independently, and it is
 * perfectly possible for everybody to fail. The hook is what guarantees at
 * least one of them does.
 */
function handResult(state: GameState): EventBody[] {
  const dealer = dealerOf(state);
  if (!dealer) return [];

  const scores: Record<PlayerId, number> = {};
  for (const playerId of state.inPlay) {
    scores[playerId] = scoreFor(callOf(state, playerId) ?? 0, tricksTaken(state, playerId));
  }

  // Best round first. Everybody who scored nothing is last, in seat order,
  // which is as much as can honestly be said about them.
  const rankings = [...state.inPlay].sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));

  return [
    // The next rung of the ladder, and the deal one seat to the left. Both
    // written only on a hand that was actually scored, so an abandoned hand
    // replays the same round with the same dealer rather than skipping it.
    { type: 'gameDataSet', key: 'nextRound', value: roundOf(state) + 1 },
    { type: 'gameDataSet', key: 'nextDealer', value: nextSeatOf(state, dealer) },
    { type: 'gameEnded', rankings, scores },
  ];
}

/** The next seat the way the deal travels: one to the left, clockwise. */
function nextSeatOf(state: GameState, playerId: PlayerId): PlayerId {
  const seats = state.seatOrder;
  const at = seats.indexOf(playerId);
  return seats[(at + 1) % Math.max(seats.length, 1)] ?? playerId;
}
