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
 * dealer's right sets one of their own cards face down. Its suit is trump,
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

/** Stakes are named in eights, as high as thirty-two. */
const STAKE_STEP = 8;
const MAX_STAKE = 32;
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

type Stage = 'bidding' | 'calling' | 'playing';

// --- reading the table -----------------------------------------------------
//
// None of this is exported. Every ruleset has a `legalCards` and a `quotaFor`,
// and only one of them can own the bare word -- so the way in from outside is
// this ruleset's own hooks, which is the same door the client uses.

function stage(state: GameState): Stage {
  const at = state.gameData['stage'];
  if (at === 'playing') return 'playing';
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

/**
 * The next seat the way play travels.
 *
 * Both the deal and the play run anticlockwise, and `seatOrder` is taken to
 * run the same way -- so the next entry is the player to this one's right, and
 * one step is always an opponent while two is always a partner.
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

/** Whoever sets the trump aside and leads: the player to the dealer's right. */
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
 * A card of the trump suit played before the reveal was never a trump, so
 * trumpiness is a question about *when* as much as about what. The reveal is
 * recorded as two numbers -- the trick it happened in and how many cards were
 * already down -- which is enough to answer it exactly, including for the one
 * trick that was half played when the trump came up.
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

// --- the auction -----------------------------------------------------------

function bidOf(state: GameState, playerId: PlayerId): number | null {
  const value = state.gameData[`bid:${playerId}`];
  return typeof value === 'number' ? value : null;
}

/** The first player, going round from the dealer's right, yet to speak. */
function nextBidder(state: GameState): PlayerId | null {
  return state.inPlay.find((id) => bidOf(state, id) === null) ?? null;
}

/** The highest stake declared so far; zero when everybody has passed. */
function standingStake(state: GameState): number {
  return state.inPlay.reduce((high, id) => Math.max(high, bidOf(state, id) ?? 0), 0);
}

/**
 * Who has won the bidding, once it has been all the way round.
 *
 * The highest stake takes it, and a tie goes to the dealer. Between two others
 * it goes to whoever said the number first -- which is the only thing that
 * *can* decide it. Nearness to the dealer sounds like the obvious tie-break
 * and is no tie-break at all: in a ring of four the two players who are not
 * the dealer's partner both sit one seat from the dealer, on either side of
 * them, so they are always exactly as near as each other.
 */
function auctionWinner(state: GameState): { playerId: PlayerId; stake: number } | null {
  const stake = standingStake(state);
  if (stake === 0) return null;

  const tied = state.inPlay.filter((id) => bidOf(state, id) === stake);
  const dealer = dealerOf(state);
  if (dealer && tied.includes(dealer)) return { playerId: dealer, stake };

  // `inPlay` is the order they spoke in, so the front of it is the first to
  // have named this stake.
  return tied[0] !== undefined ? { playerId: tied[0], stake } : null;
}

function parseStake(option: string): number | null {
  if (!option.startsWith(STAKE_PREFIX)) return null;
  const stake = Number(option.slice(STAKE_PREFIX.length));
  if (!Number.isInteger(stake) || stake <= 0) return null;
  return stake;
}

/** The stakes still open: eights from the standing call up to the ceiling. */
function stakeLadder(standing: number): number[] {
  const stakes: number[] = [];
  for (let stake = Math.max(STAKE_STEP, standing); stake <= MAX_STAKE; stake += STAKE_STEP) {
    stakes.push(stake);
  }
  return stakes;
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
  // Nothing is played during the bidding.
  if (at === 'bidding') return [];
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
 * Where a vakkhai partner's hand waits out the deal.
 *
 * A pile, which is what it is: cards that have gone somewhere sealed and
 * face down and are not coming back this hand. Saying so rather than calling
 * it a meld is what keeps the table honest about it -- the last card played
 * wears a ring, and withdrawing four cards is not a play, so ringing them
 * points at the one thing on the table that did not just happen.
 */
function outZone(): Zone {
  return {
    id: OUT_ZONE,
    kind: 'pile',
    owner: null,
    layout: 'stack',
    faceDownVisibleTo: 'none',
    openToOthers: false,
    sealed: true,
    cards: [],
    pos: { x: 0.86, y: 0.2 },
    label: 'out',
  };
}

export const laddis: Ruleset = {
  id: 'laddis',
  name: 'लॅडीस',
  blurb: 'Four players, two sides. Take your quota of the eight tricks — or declare वख्खै and play alone.',
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
      'If everybody passes, the player to the dealer\'s right sets one of their own cards face down. Its suit is trump and they alone know it.',
      'Nothing is a trump until the card is turned up. Anybody who cannot follow suit may ask for it on their turn — and cards of that suit played earlier in the hand were never trumps.',
      'The dealers need four of the eight tricks; the other side needs five. Four and five out of eight means one side always gets there, so the hand ends the moment either does.',
      'The non-dealers getting there posts 5 onto the dealers. The dealers getting there posts 10 onto the non-dealers, settling against whatever they were carrying first.',
      'Whoever is carrying points deals. Land on nothing and the same side deals again; within a side the deal crosses to the partner every thirty-two points.',
      'वख्खै is a hand taken on alone: your partner\'s cards are withdrawn, three of you play four tricks with no trump, and you must win every one. Name your stake in eights — win and it goes on them, lose and double goes on you.',
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
    if (state.phase !== 'playing' || stage(state) !== 'bidding') return null;
    const bidder = nextBidder(state);
    if (!bidder) return null;

    const standing = standingStake(state);
    const held = state.inPlay.find((id) => bidOf(state, id) === standing && standing > 0) ?? null;

    return {
      bidder,
      prompt:
        standing > 0
          ? `${nameOf(state, held)} will take the hand on alone for ${standing}. Say more, or pass.`
          : 'Four cards. Declare वख्खै to play this hand alone against both opponents — or pass, and let a trump be set.',
      standing: standing > 0 ? `${nameOf(state, held)} — वख्खै for ${standing}` : null,
      stakes: stakeLadder(standing),
      stakePrefix: STAKE_PREFIX,
      declareLabel: 'Declare वख्खै',
      passOption: PASS_BID,
      passLabel: 'Pass',
    };
  },

  instruction(state: GameState, playerId: PlayerId): string | null {
    if (state.phase !== 'playing') return null;

    if (stage(state) === 'calling') {
      const caller = callerOf(state);
      if (!caller) return null;
      return caller === playerId
        ? 'Set one card face down — its suit is trump, and only you will know it'
        : `${nameOf(state, caller)} is setting a trump aside`;
    }

    const declarer = declarerOf(state);
    if (declarer && stage(state) === 'playing' && partnersOf(state, declarer).includes(playerId)) {
      return 'You are sitting this hand out — your cards are withdrawn';
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

    return [
      {
        playerId: dealer ?? dealers[0] ?? '',
        team: dealers,
        won: tricksFor(state, dealers),
        quota: DEALER_QUOTA,
        note: 'deals',
      },
      {
        playerId: others[0] ?? '',
        team: others,
        won: tricksFor(state, others),
        quota: CHALLENGER_QUOTA,
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
    // Setting the trump aside is a card being played, not a question: the hand
    // has to stay lit and tappable, so the table is not told to stand down.
    if (stage(state) === 'bidding') return nextBidder(state);
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

    // Turn order runs from the dealer's right, who sets the trump and leads.
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

    // Four each, in turn order, starting with the player to the dealer's right.
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

    const at = stage(state);

    if (at === 'bidding') {
      if (intent.type === 'choose') {
        const bidder = nextBidder(state);
        if (actor !== bidder) return { ok: false, reason: 'it is not your call' };
        if (intent.option === PASS_BID) return ALLOW;
        const stake = parseStake(intent.option);
        if (stake === null) return { ok: false, reason: 'declare a stake, or pass' };
        if (!stakeLadder(standingStake(state)).includes(stake)) {
          return { ok: false, reason: `stakes go in ${STAKE_STEP}s, as high as ${MAX_STAKE}` };
        }
        return ALLOW;
      }
      return administering() ? ALLOW : { ok: false, reason: 'the bidding is still going round' };
    }

    if (at === 'calling') {
      if (intent.type === 'move') {
        // Rearranging your own hand is fine at any point.
        if (intent.toZone === `hand:${actor}`) {
          return intent.cardIds.every((id) => state.cards[id]?.zone === `hand:${actor}`)
            ? ALLOW
            : { ok: false, reason: 'a card that is played stays played' };
        }
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
    const at = stage(state);

    // --- the auction ------------------------------------------------------
    //
    // `chosen` changes nothing by itself -- the engine does not know what an
    // option means -- so the bid is written down here, and the round is
    // settled when the writing-down shows everybody has spoken.
    if (at === 'bidding') {
      if (event.type === 'chosen') {
        const stake = event.option === PASS_BID ? 0 : (parseStake(event.option) ?? 0);
        return [{ type: 'gameDataSet', key: `bid:${event.by}`, value: stake }];
      }

      if (event.type === 'gameDataSet' && event.key.startsWith('bid:')) {
        if (nextBidder(state) !== null) return [];
        const won = auctionWinner(state);
        return won ? declareAlone(state, won) : [{ type: 'gameDataSet', key: 'stage', value: 'calling' }];
      }

      return [];
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
 * dealer's right would otherwise lead a hand they may not even be in.
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

  return [
    { type: 'gameDataSet', key: 'stake', value: won.stake },
    { type: 'gameDataSet', key: 'vakkhai', value: won.playerId },
    { type: 'gameDataSet', key: 'stage', value: 'playing' },
    ...(placements.length > 0 ? [{ type: 'cardsMoved' as const, placements }] : []),
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
    { type: 'gameDataSet', key: 'stage', value: 'playing' },
    { type: 'cardsMoved', placements },
    { type: 'turnSet', playerId: caller },
  ];
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
