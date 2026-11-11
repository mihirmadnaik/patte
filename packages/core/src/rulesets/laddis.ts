/**
 * लॅडीस (Laddis) — four players, two sides, and one ledger between them.
 *
 * The first game here played in partnerships, and the first scored as a
 * running balance rather than a column of rounds. Both of those are the same
 * idea: nothing in लॅडीस belongs to a player. Points are posted onto a *side*,
 * and the side carrying them is the side that deals.
 *
 * **The ledger is one signed number.** A result is posted onto the other side,
 * and a posting cancels against whatever that side's opponents were already
 * carrying. Non-dealers meeting their quota post 5 onto the dealers;
 * dealers meeting theirs post 10 onto the non-dealers. So a dealing side
 * carrying 5 that wins posts 10, keeps 5 of it to wipe their own, and hands 5
 * over -- and with it the deal. Land on nothing and the same side deals again.
 *
 * **The quotas do not match, and that is the whole shape of the game.** The
 * dealers need four of the eight tricks and the non-dealers five. Nine out of
 * eight means exactly one side always qualifies, so the hand can never be
 * drawn and ends the moment either of them gets there. The dealers have the
 * easier half and the bigger prize, which is why dealing is a burden you are
 * put under rather than a turn you take.
 *
 * Two mechanics the engine had never needed:
 *
 * **A trump nobody can see.** When everybody passes, the player to the
 * dealer's left sets one of their own cards face down. Its suit is trump,
 * they alone know it, and anybody who cannot follow suit may demand it be
 * turned up. Until that happens *nothing is a trump* -- a card of that suit
 * played earlier in the hand was only ever a card of that suit, which is the
 * clause that gives the mechanic its character. It is held as a card in a
 * zone, never as a suit in `gameData`, because `gameData` is public: a trump
 * written there would be readable by every client on the table.
 *
 * **वख्खै (vakkhai).** On four cards a player may declare that they will
 * take on both opponents with their partner's cards taken off the table. Three
 * players, four tricks, no trump, and the declarer must win every one of them.
 * They name their own stake in eights; succeed and it is posted onto the other
 * side, fail and double it is posted onto their own.
 */

import { buildDeck, shuffled } from '../deck.js';
import {
  TABLE_INTENTS,
  type CardPlacement,
  type EventBody,
  type GameEvent,
  type Intent,
} from '../intents.js';
import {
  partnersOf,
  teamOf,
  type CardId,
  type GameState,
  type PlayerId,
  type Suit,
  type Zone,
  type ZoneId,
} from '../state.js';
import { handZone } from './freeplay.js';
import {
  HAND_SUITS,
  STOCK_ZONE,
  SUIT_LABEL,
  TAKE,
  TRICK_ZONE,
  TRUMP_SUITS,
  awaitingCollection,
  dealerOf,
  pileTricks,
  pileZone,
  stockZone,
  suitLed,
  trickCards,
  trickWinner,
  trickZone,
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

const SEATS = 4;
/** Four sevens is every seven there is, which is a hand worth refusing. */
const SUITS_IN_PACK = 4;
/** Thirty-two cards: ace down to seven, nothing below it, ace high. */
const RANKING = ['A', 'K', 'Q', 'J', '10', '9', '8', '7'] as const;

/** Four cards to bid on, then four more once the bidding is over. */
const FIRST_BATCH = 4;
const SECOND_BATCH = 4;

/** Eight tricks in a standing hand; four when somebody is playing alone. */
const TRICKS_STANDING = 8;
const TRICKS_ALONE = 4;

/** The dealers need four of the eight. The other side needs five. */
const DEALER_QUOTA = 4;
const CHALLENGER_QUOTA = 5;
/** What meeting your quota posts onto the other side.  */
const DEALER_POSTS = 10;
const CHALLENGER_POSTS = 5;

/**
 * The stakes there are: eight, sixteen, thirty-two.
 *
 * A doubling rather than a count of eights -- twenty-four is not a figure
 * anybody calls. Written out rather than generated, because it is a list of
 * what may be said and not a sequence that happens to have three terms in it.
 */
const STAKES: readonly number[] = [8, 16, 32];
/**
 * Every thirty-two points the deal crosses to the partner.
 *
 * Whoever is carrying the balance deals, which without this would mean one
 * player of a side that is losing badly deals for ever.
 */
const LEDGER_BAND = 32;

/** The face-down card whose suit is trump. */
const TRUMP_ZONE: ZoneId = 'trump';
/** Where a vakkhai partner's withdrawn hand sits out the deal. */
const OUT_ZONE: ZoneId = 'out';

/** Asking for the hidden trump to be turned up. */
const ASK = 'ask';
/** Saying nothing in the auction. */
const PASS_BID = 'pass';
/** A declaration is sent as this plus the stake: `vakkhai:16`. */
const STAKE_PREFIX = 'vakkhai:';
/** Turning down the fresh deal four sevens entitles you to. */
const PLAY_ON = 'play-on';

/**
 * The offers there are: six of the eight tricks, or seven, or all eight.
 *
 * Six is the floor because the hand it replaces only asks four or five, and
 * eight is the ceiling because eight is every trick there is.
 */
const OFFERS: readonly number[] = [6, 7, 8];
/** Eight tricks, so an offer of six leaves the other side needing three. */
const AGAINST_OFFER = TRICKS_STANDING + 1;
/** An offer is sent as this plus the wager and the suit: `offer:6:S`. */
const OFFER_PREFIX = 'offer:';
/** Taking one is sent as this plus the wager, so a stale panel cannot. */
const TAKE_OFFER_PREFIX = 'take-offer:';
/** Making no offer at all, which is what most hands hear four times. */
const NO_OFFER = 'no-offer';
/** Giving up a tie rather than raising over it. */
const STAND_DOWN = 'stand-down';
/** Refusing the offer your partner has put to you. */
const REFUSE_OFFER = 'refuse-offer';

type Stage = 'bidding' | 'calling' | 'offering' | 'playing';

// --- reading the table -----------------------------------------------------
//
// None of this is exported. Every ruleset has a `legalCards` and a `quotaFor`,
// and only one of them can own the bare word -- so the way in from outside is
// this ruleset's own hooks, which is the same door the client uses.

function stage(state: GameState): Stage {
  const at = state.gameData['stage'];
  if (at === 'playing') return 'playing';
  if (at === 'offering') return 'offering';
  if (at === 'calling') return 'calling';
  return 'bidding';
}

function numberAt(state: GameState, key: string): number {
  const value = state.gameData[key];
  return typeof value === 'number' ? value : 0;
}

function textAt(state: GameState, key: string): string | null {
  const value = state.gameData[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function nameOf(state: GameState, playerId: PlayerId | null): string {
  return (playerId && state.players[playerId]?.name) || 'Another player';
}

/** Several people, read out the way you would say them. */
function nameList(state: GameState, players: readonly PlayerId[]): string {
  const names = players.map((id) => nameOf(state, id));
  if (names.length <= 1) return names[0] ?? 'Nobody';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * The next seat the way play travels.
 *
 * Both the deal and the play run clockwise, which is the way `seatOrder`
 * runs -- so the next entry is the player to this one's left, and one step is
 * always an opponent while two is always a partner.
 */
function nextSeat(seats: readonly PlayerId[], playerId: PlayerId): PlayerId {
  const at = seats.indexOf(playerId);
  return seats[(at + 1) % Math.max(seats.length, 1)] ?? playerId;
}

/** Directly across the table, which with four seats is your partner. */
function partnerSeat(seats: readonly PlayerId[], playerId: PlayerId): PlayerId {
  const at = seats.indexOf(playerId);
  return seats[(at + 2) % Math.max(seats.length, 1)] ?? playerId;
}

/** Whoever sets the trump aside and leads: the player to the dealer's left. */
function callerOf(state: GameState): PlayerId | null {
  return state.inPlay[0] ?? null;
}

/** The player taking the hand on alone, if somebody declared. */
function declarerOf(state: GameState): PlayerId | null {
  return textAt(state, 'vakkhai');
}

function stakeOf(state: GameState): number {
  return numberAt(state, 'stake');
}

/** One card per player to a trick -- three of them when one is sitting out. */
function trickSize(state: GameState): number {
  return declarerOf(state) ? SEATS - 1 : SEATS;
}

function tricksInHand(state: GameState): number {
  return declarerOf(state) ? TRICKS_ALONE : TRICKS_STANDING;
}

/**
 * Who is actually playing, in turn order.
 *
 * Everyone dealt in, less a partner who has been withdrawn for a vakkhai.
 * `inPlay` stays the four who were dealt to -- the partner is sitting out the
 * hand, not out of the game, and the result still lands on their side.
 */
function order(state: GameState): PlayerId[] {
  const declarer = declarerOf(state);
  if (!declarer) return [...state.inPlay];
  const sitting = new Set(partnersOf(state, declarer));
  return state.inPlay.filter((id) => !sitting.has(id));
}

function handCards(state: GameState, playerId: PlayerId): CardId[] {
  return state.zones[`hand:${playerId}`]?.cards ?? [];
}

/** The side a player is on, as the list of players. */
function sideOf(state: GameState, playerId: PlayerId): PlayerId[] {
  const at = teamOf(state, playerId);
  return at < 0 ? [playerId] : [...(state.teams[at] ?? [])];
}

function sameSide(state: GameState, a: PlayerId, b: PlayerId): boolean {
  return sideOf(state, a).includes(b);
}

/** The dealing side, and the one trying to put points on it. */
function dealingSide(state: GameState): PlayerId[] {
  const dealer = dealerOf(state);
  return dealer ? sideOf(state, dealer) : [];
}

/**
 * Everybody not on this player's side.
 *
 * Read off `teams` rather than filtered out of `inPlay`, so a side is always
 * named in the same order. `inPlay` rotates with the deal, and a strip that
 * said "Ben & Dev" one hand and "Dev & Ben" the next looked like the sides
 * themselves had changed.
 */
function otherSide(state: GameState, playerId: PlayerId): PlayerId[] {
  const mine = sideOf(state, playerId);
  return state.teams.find((team) => !team.some((id) => mine.includes(id))) ?? [];
}

function tricksFor(state: GameState, players: readonly PlayerId[]): number {
  const size = trickSize(state);
  return players.reduce((total, id) => total + pileTricks(state, id, size), 0);
}

/** How many tricks have been gathered, which is also the trick now in play. */
function tricksPlayed(state: GameState): number {
  return tricksFor(state, state.inPlay);
}

// --- the hidden trump ------------------------------------------------------

function hiddenTrumpCard(state: GameState): CardId | null {
  return state.zones[TRUMP_ZONE]?.cards[0] ?? null;
}

/**
 * The trump suit, once everybody is entitled to know it.
 *
 * Deliberately not the suit of the face-down card: that is held in a zone
 * nobody may see into, and the moment it is turned up the suit is written to
 * `gameData`, which is public. So this reads the public fact and nothing else.
 */
function revealedTrump(state: GameState): Suit | null {
  const named = state.gameData['trump'];
  return typeof named === 'string' && TRUMP_SUITS.includes(named as Suit) ? (named as Suit) : null;
}

/**
 * Whether the card at this position in the trick being judged is a trump.
 *
 * A card of the trump suit played before the reveal was never a trump: the
 * suit was a secret when it went down, so it was played as a discard and is
 * judged as one. Trumpiness is therefore a question about *when* as much as
 * about what, and the reveal is recorded as two numbers -- the trick it
 * happened in, and how many cards were already lying there -- which answers
 * it exactly, including for the one trick that was half played when the
 * trump came up.
 *
 * This is the table's rule, chosen with its consequence known: lead a heart,
 * somebody throws the king of spades, the next player cannot follow and calls
 * for the trump, which is spades, and then takes the trick with the seven.
 * The seven beats the king because the king was put down a moment too early,
 * and that is the point -- it was not a trump when it was played, and asking
 * for the trump is what makes one.
 *
 * Tricks already gathered are never reopened. They were won under what the
 * table knew at the time and they are face down in somebody's pile.
 */
function trumpedAt(state: GameState): (cardId: CardId, index: number) => boolean {
  const trump = revealedTrump(state);
  if (!trump) return () => false;

  const from = numberAt(state, 'revealTrick');
  const after = numberAt(state, 'revealAt');
  const now = tricksPlayed(state);

  return (cardId: CardId, index: number): boolean => {
    if (state.cards[cardId]?.face?.suit !== trump) return false;
    if (now !== from) return now > from;
    return index >= after;
  };
}

/**
 * Whether this player may demand the trump be turned up.
 *
 * Only on your turn, only while it is still down, and only when you cannot
 * follow what was led -- which is the whole point of asking. Whoever is
 * leading can always follow their own suit, so they never can.
 */
function mayAsk(state: GameState, playerId: PlayerId): boolean {
  if (state.phase !== 'playing' || stage(state) !== 'playing') return false;
  if (state.turn !== playerId || hiddenTrumpCard(state) === null) return false;
  if (awaitingCollection(state, trickSize(state)) !== null) return false;
  const led = suitLed(state, trickSize(state));
  if (!led) return false;
  return !handCards(state, playerId).some((id) => state.cards[id]?.face?.suit === led);
}

// --- a hand nobody should have to play --------------------------------------

/** Set once this player has said they will play a four-seven hand after all. */
function playsOnKey(playerId: PlayerId): string {
  return `playson:${playerId}`;
}

function holdsEverySeven(state: GameState, playerId: PlayerId): boolean {
  const sevens = handCards(state, playerId).filter(
    (id) => state.cards[id]?.face?.rank === '7',
  ).length;
  return sevens >= SUITS_IN_PACK;
}

/**
 * Whoever the table is waiting on to say whether this hand is played at all.
 *
 * The entitlement used to lapse the moment anybody put a card down, and the
 * card that ended it was almost never theirs: the hand is dealt out, the
 * offer appears, and the caller leads a second later from the other side of
 * the table. So the offer is the hand's own business now -- nothing is set
 * aside and nothing is played until it has been answered -- and the answer is
 * sent, rather than remembered in one browser, so that the rest of the table
 * can tell the difference between a player thinking and a player who has
 * decided to play on.
 *
 * The played-a-card test stays as the backstop it always was: if a card is
 * somehow down, the moment has passed whatever anybody has said.
 */
function sevensClaimant(state: GameState): PlayerId | null {
  if (state.phase !== 'playing') return null;
  if (tricksPlayed(state) > 0 || trickCards(state).length > 0) return null;
  return (
    state.inPlay.find(
      (id) => state.gameData[playsOnKey(id)] !== true && holdsEverySeven(state, id),
    ) ?? null
  );
}

// --- the offer -------------------------------------------------------------
//
// A trump nobody can see is the heart of this game, and it is also the one
// thing a player holding a strong suit can do nothing about. The offer is the
// way out: once the trump is down and the hand is dealt, a player may offer
// their partner a contract -- six of the eight tricks or more, played in a
// suit they name out loud -- and if the partner takes it, the named suit is
// trump from the first card and the hidden one goes back into the hand it
// came from, never seen.
//
// Everything about an offer is public, wager and suit both. That is the price
// of it: naming your suit tells the opponents where your strength is, and a
// refused offer tells them for nothing.
//
// Six and the three it leaves add up to nine against eight tricks, so exactly
// one side gets there and the hand ends the moment it is decided -- the same
// shape as the four and five it replaces.

/** What this player offered: the wager, 0 for none, null while unasked. */
function offerOf(state: GameState, playerId: PlayerId): number | null {
  const value = state.gameData[`offer:${playerId}`];
  return typeof value === 'number' ? value : null;
}

function offerSuitOf(state: GameState, playerId: PlayerId): Suit | null {
  const named = textAt(state, `offerSuit:${playerId}`);
  return named && HAND_SUITS.includes(named as Suit) ? (named as Suit) : null;
}

/** What they said in the run-off: the wager, 0 for standing down. */
function runoffAnswerOf(state: GameState, playerId: PlayerId): number | null {
  const value = state.gameData[`ro:${playerId}`];
  return typeof value === 'number' ? value : null;
}

/**
 * The figure this player is standing on.
 *
 * Their run-off answer where they gave one, because a raise is the wager now;
 * otherwise the offer they opened with.
 */
function wagerOf(state: GameState, playerId: PlayerId): number {
  return runoffAnswerOf(state, playerId) ?? offerOf(state, playerId) ?? 0;
}

/** The two tied players, while a run-off between them is open. */
function offerRunoffPair(state: GameState): PlayerId[] | null {
  const list = textAt(state, 'offerRunoff');
  if (!list) return null;
  const pair = list.split('|').filter((id) => state.inPlay.includes(id));
  return pair.length === 2 ? pair : null;
}

/** The offer put to a partner and not yet answered. */
function offerOnTable(state: GameState): { by: PlayerId; wager: number; suit: Suit } | null {
  const by = textAt(state, 'offerBy');
  if (!by || !state.inPlay.includes(by)) return null;
  // Read off the offer as it was put, not off the offerer: a run-off raises
  // the wager, and what the partner is answering is the figure on the table.
  const named = textAt(state, 'offerTrump');
  const suit = named && HAND_SUITS.includes(named as Suit) ? (named as Suit) : null;
  const wager = numberAt(state, 'offerWager');
  return suit && wager > 0 ? { by, wager, suit } : null;
}

/** The side that took a contract, once one has been taken. */
function offerSideOf(state: GameState): PlayerId | null {
  const by = textAt(state, 'offerSide');
  return by && state.inPlay.includes(by) ? by : null;
}

/** How many of the eight the offering side owes. Zero when nobody offered. */
function offerStakeOf(state: GameState): number {
  return offerSideOf(state) ? numberAt(state, 'offerStake') : 0;
}

/** The next player who owes the circuit an answer, in seating order. */
function nextOfferer(state: GameState): PlayerId | null {
  return state.inPlay.find((id) => offerOf(state, id) === null) ?? null;
}

/** The best offer a side has made: the highest, and the earliest said. */
function bestOfSide(state: GameState, side: readonly PlayerId[]): PlayerId | null {
  // Walked in seating order, and only beaten by a strictly higher wager, so
  // two partners at the same number leaves it with whoever spoke first.
  let best: PlayerId | null = null;
  for (const playerId of state.inPlay) {
    if (!side.includes(playerId)) continue;
    if ((offerOf(state, playerId) ?? 0) <= 0) continue;
    if (best === null || wagerOf(state, playerId) > wagerOf(state, best)) best = playerId;
  }
  return best;
}

/** The offers made so far, in the words the panel shows the table. */
function offersSoFar(state: GameState): string | null {
  const said = state.inPlay
    .filter((id) => (offerOf(state, id) ?? 0) > 0)
    .map((id) => `${nameOf(state, id)} ${wagerOf(state, id)} in ${SUIT_LABEL[offerSuitOf(state, id) ?? 'S']}`);
  return said.length > 0 ? said.join(' · ') : null;
}

function parseOffer(option: string): { wager: number; suit: Suit | null } | null {
  if (!option.startsWith(OFFER_PREFIX)) return null;
  const [figure, suit] = option.slice(OFFER_PREFIX.length).split(':');
  const wager = Number(figure);
  if (!OFFERS.includes(wager)) return null;
  if (suit === undefined) return { wager, suit: null };
  return HAND_SUITS.includes(suit as Suit) ? { wager, suit: suit as Suit } : null;
}

function parseTakeOffer(option: string): number | null {
  if (!option.startsWith(TAKE_OFFER_PREFIX)) return null;
  const wager = Number(option.slice(TAKE_OFFER_PREFIX.length));
  return OFFERS.includes(wager) ? wager : null;
}

/**
 * The question this stage is putting to somebody, if it is putting one.
 *
 * Three questions in one shape, because they are one question asked at
 * different depths: will you offer, which of you gives way, and will you take
 * it. The client renders all three from `AuctionCall` without knowing which.
 */
function offerCall(state: GameState): AuctionCall | null {
  // Nothing is asked while the table is waiting to hear whether this hand is
  // being played at all.
  if (sevensClaimant(state) !== null) return null;

  const table = offerOnTable(state);
  if (table) {
    const partner = partnersOf(state, table.by)[0];
    if (!partner) return null;
    const suit = SUIT_LABEL[table.suit];
    return {
      bidder: partner,
      prompt: `${nameOf(state, table.by)} will take ${table.wager} of the eight tricks with ${suit} as trump. Take it and your side must make ${table.wager}, or ${table.wager * 2} goes on you.`,
      standing: `${nameOf(state, table.by)} offers ${table.wager} in ${suit}`,
      // One rung, because there is nothing to decide about the number: the
      // only question is whether you are in.
      stakes: [table.wager],
      stakePrefix: TAKE_OFFER_PREFIX,
      declareLabel: 'Take the offer',
      stakeLabel: 'Tricks',
      hold: { stake: table.wager, label: `Take the offer — ${table.wager} in ${suit}` },
      passOption: REFUSE_OFFER,
      passLabel: 'Refuse',
      hint: 'Refuse, and the hand is played on the hidden trump.',
    };
  }

  const pair = offerRunoffPair(state);
  if (pair) {
    const bidder = pair.find((id) => runoffAnswerOf(state, id) === null);
    if (!bidder) return null;
    const mine = wagerOf(state, bidder);
    const others = pair.filter((id) => id !== bidder);
    const names = nameList(state, others);
    const capped = mine >= OFFERS[OFFERS.length - 1]!;
    return {
      bidder,
      prompt: capped
        ? `You and ${names} have both offered ${mine}, which is every trick there is. Keep it, or stand down — and if neither of you moves, it goes to the side that is not dealing.`
        : `You and ${names} have both offered ${mine}. Say more, keep yours, or stand down — and if neither of you moves, it goes to the side that is not dealing.`,
      standing: `${nameList(state, pair)} — both offering ${mine}`,
      stakes: OFFERS.filter((wager) => wager >= mine),
      stakePrefix: OFFER_PREFIX,
      declareLabel: 'Raise to',
      stakeLabel: 'Tricks',
      hold: { stake: mine, label: `Keep your ${mine}` },
      passOption: STAND_DOWN,
      passLabel: 'Stand down',
      // The suit is not asked for again: one offer, one suit.
      hint: `Your trump stays ${SUIT_LABEL[offerSuitOf(state, bidder) ?? 'S']}.`,
    };
  }

  const bidder = nextOfferer(state);
  if (!bidder) return null;
  const quota = sameSide(state, bidder, dealerOf(state) ?? bidder)
    ? DEALER_QUOTA
    : CHALLENGER_QUOTA;

  return {
    bidder,
    prompt:
      'Offer your partner six of the eight tricks or more, and name the trump you want to play it in. Everybody will see both.',
    standing: offersSoFar(state),
    stakes: [...OFFERS],
    stakePrefix: OFFER_PREFIX,
    declareLabel: 'Offer',
    stakeLabel: 'Tricks',
    suitChoice: { label: 'Trump', suits: [...HAND_SUITS] },
    passOption: NO_OFFER,
    passLabel: 'No offer',
    hint: `No offer, and your side must take ${quota} of the tricks on the hidden trump.`,
  };
}

/**
 * The circuit is over: whose offer, if anybody's, is put to their partner.
 *
 * One offer per side reaches the question -- the higher of two partners', and
 * the earlier said when they are level, because partners cannot sensibly bid
 * each other up. Between the sides the higher wager simply takes it; level is
 * a question put back to the two who made it.
 */
function settleOffers(state: GameState): EventBody[] {
  const sides = state.teams.map((side) => bestOfSide(state, side)).filter((id): id is PlayerId => id !== null);
  if (sides.length === 0) return openHandPlay(state);
  if (sides.length === 1) return putOffer(state, sides[0]!, null);

  const [first, second] = sides as [PlayerId, PlayerId];
  const high = wagerOf(state, first);
  const low = wagerOf(state, second);
  if (high > low) return putOffer(state, first, second);
  if (low > high) return putOffer(state, second, first);

  // Level across the table. Asked in seating order, so the pair is kept that
  // way rather than in the order the sides happen to sit in `teams`.
  const pair = state.inPlay.filter((id) => id === first || id === second);
  return [{ type: 'gameDataSet', key: 'offerRunoff', value: pair.join('|') }];
}

/**
 * The run-off, read once.
 *
 * Both answers are in: the higher takes it, one standing down hands it over,
 * and two players who will not move are separated by the one standing rule
 * there is -- the side not dealing is the side under pressure, so the hand is
 * theirs.
 */
function settleOfferRunoff(state: GameState, pair: readonly PlayerId[]): EventBody[] {
  const [first, second] = pair as [PlayerId, PlayerId];
  const mine = runoffAnswerOf(state, first) ?? 0;
  const theirs = runoffAnswerOf(state, second) ?? 0;

  if (mine === 0 && theirs === 0) return openHandPlay(state);
  // Whoever stood down is not kept as a fallback: they gave it up.
  if (theirs === 0) return putOffer(state, first, null);
  if (mine === 0) return putOffer(state, second, null);
  if (mine > theirs) return putOffer(state, first, second);
  if (theirs > mine) return putOffer(state, second, first);

  const dealers = dealingSide(state);
  const held = dealers.includes(first) ? second : first;
  const other = held === first ? second : first;
  return putOffer(state, held, other);
}

/** Put an offer to its partner, with the other side's underneath it. */
function putOffer(state: GameState, by: PlayerId, fallback: PlayerId | null): EventBody[] {
  return [
    { type: 'gameDataSet', key: 'offerWager', value: wagerOf(state, by) },
    { type: 'gameDataSet', key: 'offerTrump', value: offerSuitOf(state, by) ?? '' },
    { type: 'gameDataSet', key: 'offerFallback', value: fallback ?? '' },
    { type: 'gameDataSet', key: 'offerBy', value: by },
  ];
}

// --- the auction -----------------------------------------------------------
//
// One circuit of the table, and then as many run-offs as it takes.
//
// A tie used to be settled by a rule -- the dealer, or whoever spoke first --
// which decides it but does not make it fair: two players wanted the same
// hand at the same price and one of them was simply handed it. So a tie is
// now put back to the players who made it, and what they are offered depends
// on who they are. Opponents are asked to outbid each other; partners, who
// cannot sensibly bid each other up, are asked which of them is giving way.
//
// Only the ceiling ends an argument from outside: two opponents who have both
// run out of room to raise are separated by the one standing rule there is,
// which is that the side not dealing is the side under pressure, so the hand
// is theirs.

/** What a player has declared, or null while they have not spoken. */
function bidOf(state: GameState, playerId: PlayerId): number | null {
  const value = state.gameData[`bid:${playerId}`];
  return typeof value === 'number' ? value : null;
}

/** A run-off in progress: who is in it, at what stake, and which round. */
interface Runoff {
  players: PlayerId[];
  stake: number;
  round: number;
}

function runoffOf(state: GameState): Runoff | null {
  const list = textAt(state, 'runoff');
  if (!list) return null;
  const players = list.split('|').filter((id) => state.inPlay.includes(id));
  if (players.length < 2) return null;
  return { players, stake: numberAt(state, 'roStake'), round: numberAt(state, 'roRound') };
}

/** Where a player's answer to the question currently being asked is written. */
function answerKey(playerId: PlayerId, runoff: Runoff | null): string {
  return runoff ? `say${runoff.round}:${playerId}` : `bid:${playerId}`;
}

function answerOf(state: GameState, playerId: PlayerId, runoff: Runoff | null): number | null {
  const value = state.gameData[answerKey(playerId, runoff)];
  return typeof value === 'number' ? value : null;
}

/**
 * The figure this player is standing on as a round opens.
 *
 * Their answer to the round before, or their opening declaration if this is
 * the first run-off. It tells holding apart from matching: when somebody has
 * raised over you, saying the new figure is coming up to meet it, not
 * standing your ground, and the button should not claim otherwise.
 */
function figureFor(state: GameState, runoff: Runoff, playerId: PlayerId): number {
  const previous = runoff.round > 1 ? state.gameData[`say${runoff.round - 1}:${playerId}`] : undefined;
  return typeof previous === 'number' ? previous : (bidOf(state, playerId) ?? 0);
}

/** The next player who owes an answer, in seating order. Null when all have. */
function nextBidder(state: GameState): PlayerId | null {
  const runoff = runoffOf(state);
  const asking = runoff ? state.inPlay.filter((id) => runoff.players.includes(id)) : state.inPlay;
  return asking.find((id) => answerOf(state, id, runoff) === null) ?? null;
}

/** The highest stake declared so far; zero when everybody has passed. */
function standingStake(state: GameState): number {
  return state.inPlay.reduce((high, id) => Math.max(high, bidOf(state, id) ?? 0), 0);
}

/** Whether these players are all on one side of the table. */
function oneSided(state: GameState, players: readonly PlayerId[]): boolean {
  const first = players[0];
  return first === undefined || players.every((id) => sameSide(state, id, first));
}

function parseStake(option: string): number | null {
  if (!option.startsWith(STAKE_PREFIX)) return null;
  const stake = Number(option.slice(STAKE_PREFIX.length));
  if (!Number.isInteger(stake) || stake <= 0) return null;
  return stake;
}

/** The stakes at or above `floor`. */
function stakeLadder(floor: number): number[] {
  return STAKES.filter((stake) => stake >= floor);
}

/** The next stake up from this one, or null at the top. */
function above(stake: number): number | null {
  return STAKES.find((candidate) => candidate > stake) ?? null;
}

/**
 * What the player being asked may say.
 *
 * In the opening circuit, any stake from the standing one upwards, or pass.
 * In a run-off, the stake they are tied at and anything above it -- standing
 * on what you already said is an answer, and for partners it is the only one
 * there is, since you cannot sensibly outbid your own partner.
 *
 * Keeping it had been left out, which left a player who thought their
 * opponent was about to drop it with nothing to say but a raise they did not
 * want to make.
 */
function openTo(state: GameState, runoff: Runoff | null): number[] {
  if (!runoff) return stakeLadder(standingStake(state));
  return oneSided(state, runoff.players) ? [runoff.stake] : stakeLadder(runoff.stake);
}

// --- settling it -----------------------------------------------------------

/**
 * Who has won the bidding among these players, or what to ask next.
 *
 * The highest stake takes it. Several at the highest is not a tie to be
 * broken but a question to be put back to them -- every time, including at
 * the ceiling, where standing down is still something a player might want to
 * do even though raising is not.
 */
function settleAmong(state: GameState, candidates: readonly PlayerId[]): EventBody[] {
  const live = candidates.filter((id) => (bidOf(state, id) ?? 0) > 0);
  const top = live.reduce((high, id) => Math.max(high, bidOf(state, id) ?? 0), 0);
  if (top === 0) return [{ type: 'gameDataSet', key: 'stage', value: 'calling' }];

  const tied = live.filter((id) => bidOf(state, id) === top);
  if (tied.length === 1) return declareAlone(state, { playerId: tied[0]!, stake: top });
  return openRunoff(state, tied, top);
}

/** Put the tie back to the players who made it. */
function openRunoff(state: GameState, players: readonly PlayerId[], stake: number): EventBody[] {
  const round = numberAt(state, 'roRound') + 1;
  return [
    { type: 'gameDataSet', key: 'roRound', value: round },
    { type: 'gameDataSet', key: 'roStake', value: stake },
    // Written last: the other two are read through this one, so setting it
    // first would open a round whose stake and number are still last round's.
    { type: 'gameDataSet', key: 'runoff', value: players.join('|') },
  ];
}

/**
 * A run-off round is complete: see where it leaves things.
 *
 * Answers are read back as the participants' new bids rather than written
 * into `bid:` -- a write-back would be several events, and the first of them
 * would set the table resolving on figures the rest had not reached yet.
 * Whoever withdrew is simply dropped, and if they all did the hand falls to
 * whoever was bidding under them.
 */
function settleRunoff(state: GameState, runoff: Runoff): EventBody[] {
  const standing = runoff.players
    .map((playerId) => ({ playerId, stake: answerOf(state, playerId, runoff) ?? 0 }))
    .filter((entry) => entry.stake > 0);

  const close: EventBody = { type: 'gameDataSet', key: 'runoff', value: '' };

  // Everybody in the run-off gave way: the hand goes back to the table.
  if (standing.length === 0) {
    const rest = state.inPlay.filter((id) => !runoff.players.includes(id));
    return [close, ...settleAmong({ ...state, gameData: { ...state.gameData, runoff: '' } }, rest)];
  }

  if (standing.length === 1) {
    return [close, ...declareAlone(state, standing[0]!)];
  }

  const top = standing.reduce((high, entry) => Math.max(high, entry.stake), 0);

  /*
   * Somebody bettered the figure the round was called at.
   *
   * A raise is not a win; it is something the others have to answer. The
   * highest bidder used to take the hand on the spot, which meant a player
   * who had just said "I'll keep my 8" never got to hear that their opponent
   * had gone to 16, let alone come back over the top of it. So the question
   * is put again at the new figure, to everybody still in -- the raiser
   * included, who may now think better of it.
   *
   * This is what ends the auction: each round either lifts the figure, which
   * the ladder bounds, or loses a player, or finds nobody willing to move.
   */
  if (top > runoff.stake) {
    return [close, ...openRunoff(state, standing.map((entry) => entry.playerId), top)];
  }

  /*
   * Nobody moved. Everybody still in is holding the same figure, and asking
   * again would get the same answer -- which between opponents is the
   * deadlock the dealing rule exists for: the side not dealing is the side
   * the points are aimed at, so the hand is theirs. At the ceiling this is
   * the only thing that *can* happen, since there is nothing to raise to.
   *
   * Between partners it is left alone. They are not competing, they are
   * failing to agree, and nothing starts until one of them gives way.
   */
  const tied = standing.map((entry) => entry.playerId);
  if (!oneSided(state, tied)) {
    const dealer = dealerOf(state);
    const challengers = dealer ? tied.filter((id) => !sameSide(state, id, dealer)) : [];
    if (challengers.length === 1) {
      return [close, ...declareAlone(state, { playerId: challengers[0]!, stake: top })];
    }
    if (challengers.length > 1) return [close, ...openRunoff(state, challengers, top)];
  }

  return [close, ...openRunoff(state, tied, top)];
}

// --- the ledger ------------------------------------------------------------

/**
 * The whole score of a match: how much is owed, and by which side.
 *
 * One number and one side rather than a column each, because that is what it
 * is -- points sit on one side of the book at a time, and posting onto the
 * other side settles against them first.
 */
interface Ledger {
  balance: number;
  /** Any member of the side carrying it; null when the book is level. */
  owing: PlayerId | null;
}

function ledgerOf(carried: Readonly<Record<string, string | number | boolean>>): Ledger {
  const balance = typeof carried['balance'] === 'number' ? Math.max(0, carried['balance']) : 0;
  const owing = typeof carried['owing'] === 'string' && carried['owing'] !== '' ? carried['owing'] : null;
  return balance > 0 && owing ? { balance, owing } : { balance: 0, owing: null };
}

/**
 * Put `points` on a side, settling against the other side first.
 *
 * Dealers carrying 5 who post 10 keep 5 of it to wipe their own and hand 5
 * over; carrying 10 they land on nothing; carrying 20 they are still 10 down
 * and still dealing.
 */
function post(state: GameState, ledger: Ledger, onto: PlayerId, points: number): Ledger {
  if (points <= 0) return ledger;
  if (!ledger.owing || ledger.balance === 0) return { balance: points, owing: onto };
  if (sameSide(state, ledger.owing, onto)) {
    return { balance: ledger.balance + points, owing: ledger.owing };
  }
  const left = ledger.balance - points;
  if (left > 0) return { balance: left, owing: ledger.owing };
  if (left === 0) return { balance: 0, owing: null };
  return { balance: -left, owing: onto };
}

/** What this side is carrying -- nothing, unless the balance is theirs. */
function carriedBy(state: GameState, ledger: Ledger, playerId: PlayerId): number {
  if (!ledger.owing || ledger.balance === 0) return 0;
  return sameSide(state, ledger.owing, playerId) ? ledger.balance : 0;
}

/**
 * Who deals next.
 *
 * Whoever is carrying the balance deals, and at nothing the outgoing dealer
 * deals again. Within a side the same player keeps dealing until their side
 * crosses into a new band of thirty-two, when it passes across to their
 * partner -- otherwise one seat would deal through a whole losing streak.
 */
function nextDealerOf(
  state: GameState,
  seats: readonly PlayerId[],
  dealer: PlayerId,
  before: Ledger,
  after: Ledger,
): PlayerId {
  const keeps = after.owing === null ? true : sameSide(state, after.owing, dealer);
  if (!keeps) return nextSeat(seats, dealer);

  const crossed =
    Math.floor(carriedBy(state, after, dealer) / LEDGER_BAND) !==
    Math.floor(carriedBy(state, before, dealer) / LEDGER_BAND);
  return crossed ? partnerSeat(seats, dealer) : dealer;
}

// --- legality --------------------------------------------------------------

function legalCards(state: GameState, playerId: PlayerId): CardId[] {
  if (state.phase !== 'playing') return [];

  const at = stage(state);
  // Nothing is set aside and nothing is played while the table is waiting on
  // somebody entitled to throw the hand in.
  if (sevensClaimant(state) !== null) return [];
  // Nothing is played during the bidding, nor while the table is deciding
  // whether this hand is being played on somebody's named trump.
  if (at === 'bidding' || at === 'offering') return [];
  // Any of your four may be the one you set aside.
  if (at === 'calling') return playerId === callerOf(state) ? handCards(state, playerId) : [];

  if (state.turn !== playerId) return [];
  // A decided trick has to be picked up before anything may be played onto the
  // next one, or the client lights up cards the engine is about to refuse.
  if (awaitingCollection(state, trickSize(state)) !== null) return [];

  const hand = handCards(state, playerId);
  const led = suitLed(state, trickSize(state));
  if (!led) return hand;

  const following = hand.filter((id) => state.cards[id]?.face?.suit === led);
  return following.length > 0 ? following : hand;
}

// --- setup -----------------------------------------------------------------

/**
 * The card whose suit is trump, face down.
 *
 * Sealed, so that having chosen it the caller cannot quietly take it back; it
 * returns to their hand when the table turns it up, which the ruleset does
 * itself. Nobody sees into the zone -- the caller sees the card because they
 * are named on it, not because the zone lets them.
 */
function trumpZone(): Zone {
  return {
    id: TRUMP_ZONE,
    kind: 'meld',
    owner: null,
    layout: 'stack',
    faceDownVisibleTo: 'none',
    openToOthers: false,
    sealed: true,
    cards: [],
    pos: { x: 0.14, y: 0.52 },
    // Half size. Face down it is a token, not a card: it says "trump is still
    // down" and there is nothing on it to read. At full size that one bit cost
    // a phone a band of table, and when it finally does get turned up it is
    // shown full size as an announcement rather than in this corner.
    scale: 0.5,
    label: 'trump',
  };
}

/**
 * Where a vakkhai partner's hand sits out the deal, face up.
 *
 * Face up, and spread, because those four cards are information the whole
 * table is entitled to. A वख्खै is a wager that one player can take every
 * trick against two, and what the withdrawn hand held changes what everyone
 * else can still hope to hold -- the declarer's partner knew it all along,
 * and keeping it from the opponents told them something it should not. It
 * was stacked face down here, which read as the cards having been taken out
 * of the game rather than laid out of play.
 *
 * Still a pile and still sealed: they are out of the hand and nobody may
 * pick them up. Saying `pile` rather than meld is also what keeps the
 * last-played ring off them -- withdrawing four cards is not a play, and
 * ringing them would point at the one thing on the table that did not just
 * happen.
 */
function outZone(): Zone {
  return {
    id: OUT_ZONE,
    kind: 'pile',
    owner: null,
    layout: 'spread',
    // Moot while they are face up, and the honest value for cards that are
    // nobody's secret.
    faceDownVisibleTo: 'all',
    openToOthers: false,
    sealed: true,
    cards: [],
    // Clear of the stock at the left and above the trick in the middle:
    // there is nowhere for four face-up cards to go that is not somewhere,
    // and this is the band the hand is not using.
    pos: { x: 0.5, y: 0.26 },
    label: 'sitting out',
  };
}

export const laddis: Ruleset = {
  id: 'laddis',
  name: 'लॅडीस',
  blurb:
    'Four players, two sides. Take your quota of the eight tricks — declare वख्खै and play alone, or offer your partner six of them in a trump you name.',
  handOrder: { suits: HAND_SUITS, ranks: [...RANKING] },
  minPlayers: SEATS,
  maxPlayers: SEATS,
  autoStart: false,
  scoreDirection: 'low',
  scoreNote:
    'Points are a debt, not a prize: they sit on one side of the book and the side carrying them deals. Fewer is better.',
  openEnded: true,

  howToPlay: {
    goal: 'Keep the points on the other side of the book. Whoever is carrying them has to deal.',
    rules: [
      'Four players in fixed pairs, partners across the table. Thirty-two cards — ace down to seven, ace high.',
      'Four cards each to start. Anybody may declare वख्खै on them; if nobody does, a trump is set and four more cards go out for a hand of eight tricks.',
      'If everybody passes, the player to the dealer\'s left sets one of their own cards face down. Its suit is trump and they alone know it.',
      'Nothing is a trump until the card is turned up. Anybody who cannot follow suit may ask for it on their turn, and from that moment the suit is trump — but only from that moment. Cards of that suit already lying in the trick were played as discards and are judged as discards.',
      'Tricks already gathered are not reopened. They were won under what the table knew at the time.',
      'Four 7s is the four worst cards in the pack at once. Whoever is dealt them may throw the hand in, and the cards go back for a fresh deal with nothing scored.',
      'The dealers need four of the eight tricks; the other side needs five. Four and five out of eight means one side always gets there, so the hand ends the moment either does.',
      'The non-dealers getting there posts 5 onto the dealers. The dealers getting there posts 10 onto the non-dealers, settling against whatever they were carrying first.',
      'Whoever is carrying points deals. Land on nothing and the same side deals again; within a side the deal crosses to the partner every thirty-two points.',
      'वख्खै is a hand taken on alone: your partner\'s cards are withdrawn, three of you play four tricks with no trump, and you must win every one. Name your stake — 8, 16 or 32 — and win and it goes on them, lose and double goes on you.',
      'Once the trump is down and the hand is dealt, any player may offer their partner 6, 7 or 8 of the tricks — and name the trump they want to play it in. Both are said out loud, so the table learns where your strength is whether the offer is taken or not.',
      'If the partner takes it, the named suit is trump in the open from the first card and the hidden one goes back into the hand it came from, unseen. The offering side must make its number; the other side needs what is left over plus one.',
      'An offer made good posts the wager onto the other side. Missed, it posts double onto the side that offered. Refused, the hand is played on the hidden trump for the ordinary four and five.',
      'Two sides offering the same number settle it between them: raise, keep it, or stand down — and if neither moves it goes to the side that is not dealing.',
    ],
  },
  // No passing: you always hold something you are allowed to play.

  announce(
    state: GameState,
    event: GameEvent,
    viewer: PlayerId,
  ): string | { line: string; show?: CardId[] } | null {
    // The reveal, to everyone but whoever asked for it. Said on the moment the
    // suit becomes public rather than on the asking, so that what is announced
    // and what the table may know are the same event.
    if (event.type === 'gameDataSet' && event.key === 'trump') {
      const trump = revealedTrump(state);
      if (!trump) return null;

      // Nothing was turned up here: a trump was named out loud and agreed to,
      // and there is no card to hold up because the hidden one has gone back
      // into a hand unseen.
      const offering = offerSideOf(state);
      if (offering) {
        const partner = partnersOf(state, offering)[0] ?? null;
        return `${nameOf(state, partner)} takes ${nameOf(state, offering)}'s offer — ${offerStakeOf(state)} in ${SUIT_LABEL[trump]}`;
      }
      // Said to the player who asked for it as well. Everybody else has been
      // playing blind and this is the fact the rest of the hand turns on --
      // and the asker has not seen the card either.
      const card = textAt(state, 'trumpCard');
      return { line: `Trump is up — ${SUIT_LABEL[trump]}`, ...(card ? { show: [card] } : {}) };
    }

    if (event.type === 'gameDataSet' && event.key === 'vakkhai' && event.value !== viewer) {
      const declarer = typeof event.value === 'string' ? event.value : null;
      return `${nameOf(state, declarer)} has declared वख्खै for ${stakeOf(state)}`;
    }

    return null;
  },

  auction(state: GameState): AuctionCall | null {
    if (state.phase !== 'playing') return null;
    // Two auctions, one shape. The offer's is kept to itself rather than
    // folded in here: it asks a different question of a different player at
    // three different depths, and the two have no stake, ladder or tie rule
    // in common.
    if (stage(state) === 'offering') return offerCall(state);
    if (stage(state) !== 'bidding') return null;
    const bidder = nextBidder(state);
    if (!bidder) return null;

    // What saying nothing leaves the player being asked: the quota their side
    // is already carrying on an ordinary hand.
    const quota = sameSide(state, bidder, dealerOf(state) ?? bidder)
      ? DEALER_QUOTA
      : CHALLENGER_QUOTA;
    const hint = `Leave it, and your side must take ${quota} of the tricks.`;

    const runoff = runoffOf(state);
    const stakes = openTo(state, runoff);

    if (runoff) {
      const others = runoff.players.filter((id) => id !== bidder);
      const names = nameList(state, others);
      const partners = oneSided(state, runoff.players);
      const capped = above(runoff.stake) === null;
      // Level with them, or coming up to meet a raise somebody has made.
      const level = figureFor(state, runoff, bidder) >= runoff.stake;

      const prompt = partners
        ? `You and ${names} have both declared ${runoff.stake}. One of you has to give way — there is no outbidding your own partner.`
        : !level
          ? capped
            ? `${names} has gone to ${runoff.stake}, which is as high as it goes. Match it, or stand down.`
            : `${names} has gone to ${runoff.stake}. Match it, go higher, or stand down.`
          : capped
            ? `You and ${names} are at ${runoff.stake}, which is as high as it goes. Stay level and the hand goes to whichever side is not dealing.`
            : `${names} will not give way at ${runoff.stake}. Keep yours, say more, or stand down — and if nobody moves, the hand goes to whichever side is not dealing.`;

      return {
        bidder,
        prompt,
        standing: `वख्खै for ${runoff.stake} — ${nameList(state, [bidder, ...others])}`,
        stakes,
        stakePrefix: STAKE_PREFIX,
        declareLabel: 'Raise to',
        // Saying the round's figure is standing your ground, or coming up to
        // meet it. Either way it is not a bid, and the button says which.
        hold: {
          stake: runoff.stake,
          label: level ? `Keep your ${runoff.stake}` : `Match their ${runoff.stake}`,
        },
        passOption: PASS_BID,
        passLabel: partners ? 'Let them have it' : 'Stand down',
        hint,
      };
    }

    const standing = standingStake(state);
    const held = state.inPlay.find((id) => bidOf(state, id) === standing && standing > 0) ?? null;

    return {
      bidder,
      prompt:
        standing > 0
          ? `${nameOf(state, held)} will take the hand on alone for ${standing}. Say more, or pass.`
          : 'Four cards. Declare वख्खै to play this hand alone against both opponents — or pass, and let a trump be set.',
      standing: standing > 0 ? `${nameOf(state, held)} — वख्खै for ${standing}` : null,
      stakes,
      stakePrefix: STAKE_PREFIX,
      declareLabel: 'Declare वख्खै',
      passOption: PASS_BID,
      passLabel: 'Pass',
      hint,
    };
  },

  /**
   * All four sevens, which is a hand nobody should have to play.
   *
   * The sevens are the bottom of this pack -- there is nothing below them --
   * so holding every one of them is holding the four worst cards in the game
   * at once. Offered while the hand is still untouched: through the bidding,
   * through the trump being set, and up until the first card is played. It
   * can become true at either half of the deal, so it is asked rather than
   * announced once.
   */
  redealClaim(
    state: GameState,
    playerId: PlayerId,
  ): { prompt: string; said: string; declineOption: string } | null {
    if (sevensClaimant(state) !== playerId) return null;

    const name = state.players[playerId]?.name ?? 'A player';
    return {
      prompt: 'You have four 7s, would you like to redeal?',
      said: `${name} had all four 7s — dealing again`,
      declineOption: PLAY_ON,
    };
  },

  instruction(state: GameState, playerId: PlayerId): string | null {
    if (state.phase !== 'playing') return null;

    // Said to everybody, because the hand is stopped and the stop needs a
    // reason. What is not said is which cards: the claim panel tells the one
    // player who already knows, and the table finds out only if the hand
    // actually goes back.
    const sevens = sevensClaimant(state);
    if (sevens) {
      return sevens === playerId
        ? 'Four 7s — throw this hand in, or play it'
        : `${nameOf(state, sevens)} is deciding whether to play this hand`;
    }

    if (stage(state) === 'offering') {
      const call = offerCall(state);
      if (!call) return null;
      const table = offerOnTable(state);
      if (call.bidder === playerId) return null; // the panel is already asking them
      return table
        ? `${nameOf(state, call.bidder)} is deciding whether to take the offer`
        : `${nameOf(state, call.bidder)} is deciding whether to offer`;
    }

    if (stage(state) === 'calling') {
      const caller = callerOf(state);
      if (!caller) return null;
      return caller === playerId
        ? 'Set one card face down — its suit is trump, and only you will know it'
        : `${nameOf(state, caller)} is setting a trump aside`;
    }

    const declarer = declarerOf(state);
    if (declarer && stage(state) === 'playing') {
      // Four face-up cards appear in the middle of the table when somebody
      // goes alone, and nothing else on screen says whose they are or why
      // they are not in play. Said to everyone, not only to whoever is
      // sitting out, since it is the opponents the sight is new to.
      const sitting = partnersOf(state, declarer);
      if (sitting.includes(playerId)) return 'You are sitting out — your hand is face up';
      const name = nameOf(state, sitting[0] ?? null);
      return `${name} is sitting out — their hand is face up`;
    }

    return null;
  },

  standings(state: GameState): StandingsRow[] | null {
    // On screen from the moment the cards go out: somebody deciding whether to
    // declare वख्खै is deciding it against these numbers.
    if (state.phase !== 'playing' || state.teams.length === 0) return null;

    const declarer = declarerOf(state);
    const dealer = dealerOf(state);
    const playing = new Set(order(state));

    if (declarer) {
      const opponents = otherSide(state, declarer);
      return [
        {
          playerId: declarer,
          team: [declarer],
          won: tricksFor(state, [declarer]),
          quota: TRICKS_ALONE,
          note: 'alone',
        },
        {
          playerId: opponents[0] ?? declarer,
          team: opponents,
          won: tricksFor(state, opponents),
          quota: 1,
        },
      ];
    }

    // The dealing side first, so the row order says which quota is which.
    const dealers = dealingSide(state).filter((id) => playing.has(id));
    const others = (dealer ? otherSide(state, dealer) : []).filter((id) => playing.has(id));

    /*
     * A taken offer replaces both quotas at once.
     *
     * The side that took it owes its wager and the other side owes what is
     * left over plus one, which is the same arithmetic as four and five: nine
     * between them against eight tricks, so one of them always gets there.
     */
    const stake = offerStakeOf(state);
    const offering = offerSideOf(state);
    const quotaOf = (side: readonly PlayerId[], ordinary: number): number => {
      if (stake === 0 || !offering) return ordinary;
      return side.includes(offering) ? stake : AGAINST_OFFER - stake;
    };
    const noteOn = (side: readonly PlayerId[], ordinary?: string): string | undefined => {
      if (stake === 0 || !offering || !side.includes(offering)) return ordinary;
      return ordinary ? `${ordinary} · offers` : 'offers';
    };

    const dealNote = noteOn(dealers, 'deals');
    const otherNote = noteOn(others);

    return [
      {
        playerId: dealer ?? dealers[0] ?? '',
        team: dealers,
        won: tricksFor(state, dealers),
        quota: quotaOf(dealers, DEALER_QUOTA),
        ...(dealNote ? { note: dealNote } : {}),
      },
      {
        playerId: others[0] ?? '',
        team: others,
        won: tricksFor(state, others),
        quota: quotaOf(others, CHALLENGER_QUOTA),
        ...(otherNote ? { note: otherNote } : {}),
      },
    ];
  },

  inlineChoice(
    state: GameState,
    playerId: PlayerId,
  ): { label: string; option: string; note?: string } | null {
    if (awaitingCollection(state, trickSize(state)) === playerId) {
      return { label: 'Take the trick', option: TAKE, note: 'You won that trick' };
    }
    return mayAsk(state, playerId)
      // Short on purpose: the pill is one line on a phone and the button
      // beside it already says what the offer is.
      ? { label: 'Ask for trump', option: ASK, note: 'Nothing of that suit' }
      : null;
  },

  awaitingChoice(state: GameState): PlayerId | null {
    if (state.phase !== 'playing') return null;
    // Nothing is anybody's to do while a four-seven hand is being decided.
    const sevens = sevensClaimant(state);
    if (sevens) return sevens;
    // Setting the trump aside is a card being played, not a question: the hand
    // has to stay lit and tappable, so the table is not told to stand down.
    if (stage(state) === 'bidding') return nextBidder(state);
    if (stage(state) === 'offering') return offerCall(state)?.bidder ?? null;
    return awaitingCollection(state, trickSize(state));
  },

  setup({ players, match, rng, previous, reset }: SetupContext): SetupSpec {
    const seats = [...players];

    // Partners across the table. In a ring of four, two seats apart is
    // opposite however the ring is rotated, so this agrees with turn order
    // without having to be kept in step with it.
    const teams = [
      [seats[0], seats[2]].filter((id): id is PlayerId => id !== undefined),
      [seats[1], seats[3]].filter((id): id is PlayerId => id !== undefined),
    ].filter((team) => team.length > 0);

    /*
     * Who deals.
     *
     * `nextDealer` is written when a hand is scored, so it is there after a
     * hand that ended and absent after one that was abandoned -- and a redeal
     * must not move the deal on, because nothing was decided. A fresh match
     * starts the book and the deal over.
     */
    const carried = reset ? {} : previous;
    const seated = (id: unknown): PlayerId | null =>
      typeof id === 'string' && seats.includes(id) ? id : null;
    const dealer =
      seated(carried['nextDealer']) ??
      seated(carried['dealer']) ??
      seats[match.played.length % Math.max(seats.length, 1)] ??
      seats[0]!;

    // Turn order runs from the dealer's left, who sets the trump and leads.
    const turns: PlayerId[] = [];
    for (let step = 1; step <= seats.length; step++) {
      const at = (seats.indexOf(dealer) + step) % seats.length;
      const playerId = seats[at];
      if (playerId !== undefined) turns.push(playerId);
    }

    const zones: Zone[] = [trickZone(), stockZone({ x: 0.14, y: 0.2 }), trumpZone(), outZone()];
    for (const playerId of seats) zones.push(handZone(playerId), pileZone(playerId));

    const cards = buildDeck('deck', { ranks: [...RANKING] });
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

    // Four each, in turn order, starting with the player to the dealer's left.
    for (let i = 0; i < FIRST_BATCH; i++) {
      for (const playerId of turns) place(shoe[next++]!, zoneOf(`hand:${playerId}`));
    }

    // The other half waits where nobody can see it until the bidding is over.
    const stock = zoneOf(STOCK_ZONE);
    while (next < shoe.length) place(shoe[next++]!, stock);

    const ledger = ledgerOf(carried);

    return {
      zones,
      cards,
      teams,
      options: { handsArePrivate: true, enforceTurnOrder: true },
      firstTurn: turns[0] ?? null,
      inPlay: turns,
      gameData: {
        stage: 'bidding',
        dealer,
        balance: ledger.balance,
        owing: ledger.owing ?? '',
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

    // Turning down a fresh deal, which is the one thing that can be said
    // while the hand is held up -- and it is what unholds it.
    if (intent.type === 'choose' && intent.option === PLAY_ON) {
      return sevensClaimant(state) === actor
        ? ALLOW
        : { ok: false, reason: 'you have no hand to throw in' };
    }

    const held = sevensClaimant(state);
    const holding = (): Verdict => ({
      ok: false,
      reason: held
        ? `${nameOf(state, held)} may still throw this hand in`
        : 'the hand is on hold',
    });

    const at = stage(state);

    if (at === 'bidding') {
      if (intent.type === 'choose') {
        const bidder = nextBidder(state);
        if (actor !== bidder) return { ok: false, reason: 'it is not your call' };
        if (intent.option === PASS_BID) return ALLOW;
        const stake = parseStake(intent.option);
        if (stake === null) return { ok: false, reason: 'declare a stake, or pass' };
        // Judged against what this player is actually being offered, which in
        // a run-off is narrower than the whole ladder.
        if (!openTo(state, runoffOf(state)).includes(stake)) {
          return { ok: false, reason: `the stakes are ${STAKES.join(', ')}` };
        }
        return ALLOW;
      }
      return administering() ? ALLOW : { ok: false, reason: 'the bidding is still going round' };
    }

    if (at === 'offering') {
      if (intent.type === 'choose') {
        if (held) return holding();
        // Judged against the question actually being put: the same call the
        // panel is drawn from, so the two can never disagree about who is
        // being asked or what they may say.
        const call = offerCall(state);
        if (!call) return { ok: false, reason: 'there is nothing to answer' };
        if (actor !== call.bidder) return { ok: false, reason: 'it is not your call' };
        if (intent.option === call.passOption) return ALLOW;

        const taken = parseTakeOffer(intent.option);
        if (taken !== null) {
          return call.stakePrefix === TAKE_OFFER_PREFIX && call.stakes.includes(taken)
            ? ALLOW
            : { ok: false, reason: 'there is no offer to take' };
        }

        const made = parseOffer(intent.option);
        if (!made) return { ok: false, reason: `an offer is ${OFFERS.join(', ')} of the tricks` };
        if (call.stakePrefix !== OFFER_PREFIX || !call.stakes.includes(made.wager)) {
          return { ok: false, reason: `an offer is ${call.stakes.join(', ')} of the tricks` };
        }
        // A suit on the first offer and never again: the run-off raises the
        // number, and the trump was settled when the offer was made.
        if (call.suitChoice && made.suit === null) {
          return { ok: false, reason: 'name the trump you want to play it in' };
        }
        if (!call.suitChoice && made.suit !== null) {
          return { ok: false, reason: 'your trump is already named' };
        }
        return ALLOW;
      }
      return administering() ? ALLOW : { ok: false, reason: 'the offer is still going round' };
    }

    if (at === 'calling') {
      if (intent.type === 'move') {
        // Rearranging your own hand is fine at any point.
        if (intent.toZone === `hand:${actor}`) {
          return intent.cardIds.every((id) => state.cards[id]?.zone === `hand:${actor}`)
            ? ALLOW
            : { ok: false, reason: 'a card that is played stays played' };
        }
        if (held) return holding();
        if (actor !== callerOf(state)) return { ok: false, reason: 'the trump is not yours to set' };
        if (intent.toZone !== TRUMP_ZONE) return { ok: false, reason: 'set a card aside as trump' };
        if (intent.cardIds.length !== 1) return { ok: false, reason: 'one card is the trump' };
        return handCards(state, actor).includes(intent.cardIds[0]!)
          ? ALLOW
          : { ok: false, reason: 'set one of your own cards aside' };
      }
      return administering() ? ALLOW : { ok: false, reason: 'waiting for the trump to be set' };
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
      case 'choose': {
        if (intent.option !== ASK) return { ok: false, reason: 'there is nothing to choose' };
        return mayAsk(state, actor)
          ? ALLOW
          : { ok: false, reason: 'only a player who cannot follow may ask for trump' };
      }

      case 'move': {
        if (intent.toZone === `hand:${actor}`) {
          return intent.cardIds.every((id) => state.cards[id]?.zone === `hand:${actor}`)
            ? ALLOW
            : { ok: false, reason: 'a card that is played stays played' };
        }

        if (held) return holding();
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

    // Written down before anything else is read, so the bidding below cannot
    // mistake a refused redeal for a bid of nothing.
    if (event.type === 'chosen' && event.option === PLAY_ON) {
      return [{ type: 'gameDataSet', key: playsOnKey(event.by), value: true }];
    }

    const at = stage(state);

    // --- the auction ------------------------------------------------------
    //
    // `chosen` changes nothing by itself -- the engine does not know what an
    // option means -- so the bid is written down here, and the round is
    // settled when the writing-down shows everybody has spoken.
    if (at === 'bidding') {
      if (event.type === 'chosen') {
        const stake = event.option === PASS_BID ? 0 : (parseStake(event.option) ?? 0);
        return [{ type: 'gameDataSet', key: answerKey(event.by, runoffOf(state)), value: stake }];
      }

      // Only the answers move things on. The keys that describe the run-off
      // itself are written by the settling below, and reacting to those would
      // settle the same round over and over.
      if (event.type !== 'gameDataSet') return [];
      if (!event.key.startsWith('bid:') && !event.key.startsWith('say')) return [];
      if (nextBidder(state) !== null) return [];

      const runoff = runoffOf(state);
      return runoff ? settleRunoff(state, runoff) : settleAmong(state, state.inPlay);
    }

    // --- the offer --------------------------------------------------------
    //
    // The same two-step as the bidding, for the same reason: an answer is
    // written down, and it is the writing-down that settles. So there is one
    // path to the settle whether the answer came from a player or from the
    // last of three keys landing in a batch.
    if (at === 'offering') {
      if (event.type === 'chosen') {
        if (event.option === REFUSE_OFFER) return refuseOffer(state);
        if (parseTakeOffer(event.option) !== null) return acceptOffer(state);

        const inRunoff = offerRunoffPair(state) !== null;
        if (event.option === NO_OFFER) {
          return [{ type: 'gameDataSet', key: `offer:${event.by}`, value: 0 }];
        }
        if (event.option === STAND_DOWN) {
          return [{ type: 'gameDataSet', key: `ro:${event.by}`, value: 0 }];
        }

        const made = parseOffer(event.option);
        if (!made) return [];
        if (inRunoff) return [{ type: 'gameDataSet', key: `ro:${event.by}`, value: made.wager }];
        return [
          { type: 'gameDataSet', key: `offerSuit:${event.by}`, value: made.suit ?? '' },
          { type: 'gameDataSet', key: `offer:${event.by}`, value: made.wager },
        ];
      }

      // Only the answers move things on. `offerSuit:`, `offerBy` and the rest
      // describe the question rather than answer it, and reacting to those
      // would settle the same circuit over and over.
      if (event.type !== 'gameDataSet') return [];
      if (!event.key.startsWith('offer:') && !event.key.startsWith('ro:')) return [];

      const pair = offerRunoffPair(state);
      if (pair) {
        return pair.every((id) => runoffAnswerOf(state, id) !== null)
          ? settleOfferRunoff(state, pair)
          : [];
      }
      return nextOfferer(state) === null ? settleOffers(state) : [];
    }

    // --- the trump, set aside ---------------------------------------------
    if (
      at === 'calling' &&
      event.type === 'cardsMoved' &&
      event.placements.some((placement) => placement.toZone === TRUMP_ZONE)
    ) {
      return openPlay(state);
    }

    if (at !== 'playing') return [];

    // --- turning the trump up ---------------------------------------------
    if (event.type === 'chosen' && event.option === ASK) return revealTrump(state);

    /*
     * The caller runs out of cards before the tricks run out.
     *
     * They set one of their eight aside, so they hold seven for eight tricks.
     * If nobody has asked for the trump by the time their hand is empty, the
     * card has to come back to them -- there is nothing else they could play
     * -- and from that moment it is a trump like any other.
     */
    if (event.type === 'turnSet' && event.playerId !== null) {
      const caller = callerOf(state);
      if (
        caller === event.playerId &&
        hiddenTrumpCard(state) !== null &&
        handCards(state, caller).length === 0
      ) {
        return revealTrump(state);
      }
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

    // A gathered trick may have decided the hand. A *player's* pile: the
    // withdrawn hand of a vakkhai partner is a pile too, and nobody won it.
    if (
      event.placements.some((placement) => {
        const zone = state.zones[placement.toZone];
        return zone?.kind === 'pile' && zone.owner !== null;
      })
    ) {
      return handResult(state);
    }

    if (!event.placements.some((placement) => placement.toZone === TRICK_ZONE)) return [];

    const player = event.actor;
    if (!player) return [];

    const inTrick = trickCards(state);
    const turns = order(state);
    const size = trickSize(state);

    // Everyone has played: the trick is decided, and the cards stay where they
    // are until its winner takes them.
    if (inTrick.length === size) {
      const winner = trickWinner(
        state,
        inTrick,
        player,
        turns,
        revealedTrump(state),
        trumpedAt(state),
      );
      return winner ? [{ type: 'turnSet', playerId: winner }] : [];
    }

    // Otherwise it travels on round the table.
    const seat = turns.indexOf(player);
    if (seat < 0) return [];
    return [{ type: 'turnSet', playerId: turns[(seat + 1) % turns.length]! }];
  },

  legalCards,

  /**
   * Where a card may go: the middle, or -- for the one card that becomes the
   * trump -- face down beside the table.
   */
  destinationsFor(state: GameState, playerId: PlayerId, cardId: CardId): ZoneId[] {
    if (!legalCards(state, playerId).includes(cardId)) return [];
    return stage(state) === 'calling' ? [TRUMP_ZONE] : [TRICK_ZONE];
  },

  scoreboard(state: GameState): Score[] {
    const players = new Set<PlayerId>(state.seatOrder);
    for (const round of state.match.played) {
      for (const playerId of Object.keys(round.scores)) players.add(playerId);
    }
    return [...players]
      .map((playerId) => ({
        playerId,
        label: 'carrying',
        value: state.match.played.reduce((total, round) => total + (round.scores[playerId] ?? 0), 0),
      }))
      .sort((a, b) => a.value - b.value);
  },

  roundSummary(state: GameState): string {
    const round = state.match.played.at(-1);
    if (!round) return 'Hand over';

    const winner = round.rankings[0];
    if (!winner) return 'Hand over';
    const side = state.teams.find((team) => team.includes(winner)) ?? [winner];
    const names = side.map((id) => state.players[id]?.name ?? 'Player').join(' & ');

    const posted = Object.entries(round.scores).find(([, value]) => value > 0)?.[1] ?? 0;
    return posted > 0 ? `${names} take it — ${posted} onto the other side` : `${names} take it`;
  },
};

// --- what follows from what just happened ---------------------------------

/**
 * A vakkhai, declared: the partner's cards come off the table and the hand is
 * three players over four tricks.
 *
 * The declarer leads. They have wagered on beating both opponents without
 * help, and the lead is part of what they are taking on -- the player to the
 * dealer's left would otherwise lead a hand they may not even be in.
 */
function declareAlone(state: GameState, won: { playerId: PlayerId; stake: number }): EventBody[] {
  const sitting = partnersOf(state, won.playerId);
  const placements: CardPlacement[] = [];
  let index = state.zones[OUT_ZONE]?.cards.length ?? 0;
  for (const playerId of sitting) {
    for (const cardId of handCards(state, playerId)) {
      placements.push({ cardId, toZone: OUT_ZONE, toIndex: index++ });
    }
  }

  const withdrawn = placements.map((placement) => placement.cardId);

  return [
    { type: 'gameDataSet', key: 'stake', value: won.stake },
    { type: 'gameDataSet', key: 'vakkhai', value: won.playerId },
    { type: 'gameDataSet', key: 'stage', value: 'playing' },
    ...(placements.length > 0 ? [{ type: 'cardsMoved' as const, placements }] : []),
    // Turned over as they are laid out: what the partner was holding is a
    // fact the table plays the rest of the hand against, and only the
    // declarer's own side knew it.
    ...(withdrawn.length > 0
      ? [
          {
            type: 'cardsFlipped' as const,
            flips: withdrawn.map((cardId) => ({ cardId, faceUp: true })),
          },
        ]
      : []),
    { type: 'turnSet', playerId: won.playerId },
  ];
}

/**
 * The trump is down: the rest of the deal goes out and play begins.
 *
 * The caller is told their own card by name -- `revealedTo`, not the zone,
 * which stays shut to everybody. They end up with seven in hand against
 * everyone else's eight, the eighth being the card they set aside.
 */
function openPlay(state: GameState): EventBody[] {
  const caller = callerOf(state);
  const hidden = hiddenTrumpCard(state);
  if (!caller || !hidden) return [];

  const stock = state.zones[STOCK_ZONE]?.cards ?? [];
  const placements: CardPlacement[] = [];
  const dealt = new Map<PlayerId, number>(
    state.inPlay.map((id) => [id, handCards(state, id).length]),
  );
  let next = 0;

  for (let i = 0; i < SECOND_BATCH; i++) {
    for (const playerId of state.inPlay) {
      const cardId = stock[next++];
      if (!cardId) continue;
      const at = dealt.get(playerId) ?? 0;
      placements.push({ cardId, toZone: `hand:${playerId}`, toIndex: at });
      dealt.set(playerId, at + 1);
    }
  }

  return [
    { type: 'cardsRevealed', cardIds: [hidden], to: [caller] },
    // Dealt into the offer stage rather than into play: the hand is all
    // there, and the question of whether to play it on this trump comes
    // before the first card. An ordinary hand passes straight through.
    { type: 'gameDataSet', key: 'stage', value: 'offering' },
    { type: 'cardsMoved', placements },
    { type: 'turnSet', playerId: caller },
  ];
}

/**
 * The offer stage is over and nothing came of it: the hand as it has always
 * been played, on a trump nobody can see, for quotas of four and five.
 */
function openHandPlay(state: GameState): EventBody[] {
  return [
    { type: 'gameDataSet', key: 'stage', value: 'playing' },
    { type: 'turnSet', playerId: callerOf(state) },
  ];
}

/**
 * An offer, taken.
 *
 * The named suit becomes trump in the open, for every trick, and the card
 * that was set aside goes back into the hand it came from -- an ordinary card
 * from this moment, which nobody but its owner ever sees. With it gone there
 * is nothing left face down to ask about, so `mayAsk` and the caller's
 * automatic reveal both switch themselves off without being told to.
 *
 * `offerSide` is written before the trump, because the announcement fires on
 * the trump landing and has to be able to tell this from a card being turned
 * up mid-hand.
 *
 * The proposer leads. They named the suit and the number, and leading is part
 * of what they took on.
 */
function acceptOffer(state: GameState): EventBody[] {
  const table = offerOnTable(state);
  if (!table) return [];

  const hidden = hiddenTrumpCard(state);
  const caller = callerOf(state);
  const home = caller ? `hand:${caller}` : null;
  const at = home ? (state.zones[home]?.cards.length ?? 0) : 0;

  return [
    { type: 'gameDataSet', key: 'offerSide', value: table.by },
    { type: 'gameDataSet', key: 'offerStake', value: table.wager },
    { type: 'gameDataSet', key: 'trump', value: table.suit },
    // Answered, so the question stops being asked.
    { type: 'gameDataSet', key: 'offerBy', value: '' },
    ...(hidden && home
      ? [{ type: 'cardsMoved' as const, placements: [{ cardId: hidden, toZone: home, toIndex: at }] }]
      : []),
    { type: 'gameDataSet', key: 'stage', value: 'playing' },
    { type: 'turnSet', playerId: table.by },
  ];
}

/**
 * An offer, refused.
 *
 * The other side's offer stands in its place and is put to their partner --
 * winning the run-off is winning the right to be asked, not the right to
 * stop anybody else being asked. With nothing underneath it, the hand is
 * played on the hidden trump.
 */
function refuseOffer(state: GameState): EventBody[] {
  const fallback = textAt(state, 'offerFallback');
  if (fallback && state.inPlay.includes(fallback)) return putOffer(state, fallback, null);
  return [{ type: 'gameDataSet', key: 'offerBy', value: '' }, ...openHandPlay(state)];
}

/**
 * The trump, turned up.
 *
 * The suit becomes public and the card goes back to the hand it came from,
 * where it may still be played. Both numbers are written down in the same
 * breath: cards of that suit already on the table were never trumps, and the
 * trick that was half played when this happened is half trumped.
 */
function revealTrump(state: GameState): EventBody[] {
  const caller = callerOf(state);
  const hidden = hiddenTrumpCard(state);
  const suit = hidden ? state.cards[hidden]?.face?.suit : null;
  if (!caller || !hidden || !suit) return [];

  const hand = `hand:${caller}`;
  const at = state.zones[hand]?.cards.length ?? 0;

  return [
    // When it happened, which is what tells a card played as a discard from a
    // card played as a trump: the trick it came up in, and how much of that
    // trick was already on the table.
    { type: 'gameDataSet', key: 'revealTrick', value: tricksPlayed(state) },
    { type: 'gameDataSet', key: 'revealAt', value: trickCards(state).length },
    // Which card it was. Written only now, when the suit becomes public
    // anyway -- `gameData` is readable by every client, so naming the card
    // while it was still face down would have given the whole thing away.
    { type: 'gameDataSet', key: 'trumpCard', value: hidden },
    { type: 'gameDataSet', key: 'trump', value: suit },
    // Everybody has seen it, and goes on knowing which card it was: it is in
    // the caller's hand from here, and that it is there is part of the game.
    { type: 'cardsRevealed', cardIds: [hidden], to: [...state.inPlay] },
    { type: 'cardsMoved', placements: [{ cardId: hidden, toZone: hand, toIndex: at }] },
  ];
}

/**
 * Whether the hand is over, and what it did to the book.
 *
 * Quotas are checked rather than tricks counted out: four and five of eight
 * add up to nine, so one side always gets there and the hand stops when they
 * do. A vakkhai is over the instant an opponent takes a trick, which is the
 * same rule said from the other end.
 */
function handResult(state: GameState): EventBody[] {
  const before = ledgerOf(state.gameData);
  const declarer = declarerOf(state);
  const dealer = dealerOf(state);
  if (!dealer) return [];

  let winners: PlayerId[] | null = null;
  let points = 0;

  if (declarer) {
    const opponents = state.inPlay.filter((id) => !sameSide(state, id, declarer));
    const mine = tricksFor(state, [declarer]);
    const theirs = tricksFor(state, opponents);
    const stake = stakeOf(state);

    if (theirs > 0) {
      // One trick lost is the whole wager lost, and it pays double.
      winners = opponents;
      points = stake * 2;
    } else if (mine >= TRICKS_ALONE) {
      winners = sideOf(state, declarer);
      points = stake;
    }
  } else if (offerSideOf(state)) {
    /*
     * A contract, and the hand is judged on it alone -- the four-and-five
     * quotas are not in this hand at all. The side that took the offer owes
     * its wager; the other side owes what is left over plus one, so one of
     * them always gets there and the hand ends when they do.
     *
     * Winning posts the wager. Missing it posts double onto the side that
     * offered, which the ordinary machinery below does by itself: they are
     * the losers, and the losers are who a posting lands on.
     */
    const offering = offerSideOf(state)!;
    const stake = offerStakeOf(state);
    const theirs = sideOf(state, offering).filter((id) => state.inPlay.includes(id));
    const opponents = state.inPlay.filter((id) => !theirs.includes(id));

    if (tricksFor(state, theirs) >= stake) {
      winners = theirs;
      points = stake;
    } else if (tricksFor(state, opponents) >= AGAINST_OFFER - stake) {
      winners = opponents;
      points = stake * 2;
    }
  } else {
    const dealers = dealingSide(state);
    const others = state.inPlay.filter((id) => !dealers.includes(id));
    if (tricksFor(state, dealers) >= DEALER_QUOTA) {
      winners = dealers;
      points = DEALER_POSTS;
    } else if (tricksFor(state, others) >= CHALLENGER_QUOTA) {
      winners = others;
      points = CHALLENGER_POSTS;
    }
  }

  if (!winners || winners.length === 0) {
    // Nobody is there yet. Belt and braces: if the cards have run out anyway,
    // the hand cannot stay open.
    return tricksPlayed(state) >= tricksInHand(state) ? [{ type: 'matchEnded' }] : [];
  }

  const losers = state.inPlay.filter((id) => !winners!.includes(id));
  const onto = losers[0];
  const after = onto ? post(state, before, onto, points) : before;

  /*
   * A round's score is what the hand did to each side's standing, signed.
   *
   * The ledger is the only score लॅडीस has, and the engine keeps per-round
   * numbers that the scoreboard adds up. Writing the change rather than the
   * posting is what makes those two the same thing: a side that was carrying
   * five and is handed the book back scores minus five, so the running total
   * down the column is the balance itself rather than every posting ever made.
   */
  const scores: Record<PlayerId, number> = {};
  for (const playerId of state.inPlay) {
    scores[playerId] = carriedBy(state, after, playerId) - carriedBy(state, before, playerId);
  }

  const events: EventBody[] = [];

  // Whatever the trump was, the table gets to see it now the hand is done.
  const hidden = hiddenTrumpCard(state);
  if (hidden) {
    events.push({ type: 'cardsRevealed', cardIds: [hidden], to: [...state.inPlay] });
    events.push({ type: 'cardsFlipped', flips: [{ cardId: hidden, faceUp: true }] });
  }

  events.push(
    { type: 'gameDataSet', key: 'balance', value: after.balance },
    { type: 'gameDataSet', key: 'owing', value: after.owing ?? '' },
    {
      type: 'gameDataSet',
      key: 'nextDealer',
      value: nextDealerOf(state, state.inPlay, dealer, before, after),
    },
    { type: 'gameEnded', rankings: [...winners, ...losers], scores },
  );

  return events;
}
