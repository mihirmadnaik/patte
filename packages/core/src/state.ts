/**
 * The state model for a table.
 *
 * Everything on a table is a card in a zone. Deck, discard, a player's hand, a
 * trick, a meld pile and "the middle of the table" are not separate concepts --
 * they are all `Zone`s that differ only in their visibility, layout and owner.
 * Keeping that single abstraction is what lets one engine serve both free play
 * and, later, enforced rulesets.
 */

export type CardId = string;
export type ZoneId = string;
export type PlayerId = string;

export type Suit = 'C' | 'D' | 'H' | 'S';
export type Rank =
  | 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10'
  | 'J' | 'Q' | 'K' | 'JOKER';

export interface Face {
  rank: Rank;
  suit: Suit | null; // jokers have no suit
}

/** Who may see the face of a card lying face down in this zone. */
export type FaceVisibility = 'none' | 'owner' | 'all';

/** How the client arranges the cards of a zone. Purely presentational. */
export type Layout = 'stack' | 'spread' | 'fan' | 'grid' | 'free';

export type ZoneKind =
  | 'deck'
  | 'discard'
  | 'hand'
  | 'trick'
  | 'meld'
  | 'table'
  | 'row'
  /** A small face-down pile with a face-up card on top, as in 7-8. */
  | 'stack'
  /** Tricks a player has won and set aside. */
  | 'pile';

/**
 * Where a table is in the arc of a game.
 *
 * Free play is always `playing` -- there is nothing to start or finish. A game
 * with rules needs the other two: somewhere to gather before the deal, and
 * somewhere to stand once someone has won.
 */
export type Phase = 'lobby' | 'playing' | 'finished';

export interface Point {
  x: number;
  y: number;
}

export interface Zone {
  id: ZoneId;
  kind: ZoneKind;
  /** Null for shared zones (deck, discard, the table surface). */
  owner: PlayerId | null;
  layout: Layout;
  /** Who sees the faces of face-down cards here. The core of hidden information. */
  faceDownVisibleTo: FaceVisibility;
  /** May players other than the owner move cards out of this zone? */
  openToOthers: boolean;
  /**
   * Cards go in and do not come out.
   *
   * A trick you have won and a card already played to a layout are settled
   * facts. Without this the owner of a pile could pull cards back out of it --
   * `mayTakeFrom` lets a zone's owner reach into their own zone, which is
   * right for a hand and quite wrong for winnings.
   */
  sealed?: boolean;
  /** Ordered contents. Authoritative for card order. */
  cards: CardId[];
  /** Where the zone sits on the table surface, for rendering. */
  pos?: Point;
  /**
   * How big the cards here are drawn, against the table's own card size.
   *
   * Purely presentational, like `layout` and `pos`. For a zone holding a card
   * that is a *token* rather than a card you read -- लॅडीस keeps its trump
   * face down beside the table, where it is a marker saying "trump is still
   * down" and nothing more. Drawn full size it costs a phone a band of table
   * to say one bit.
   */
  scale?: number;
  label?: string;
}

export interface Card {
  id: CardId;
  /**
   * Null means "the holder of this state is not entitled to know the face".
   * The server's copy is always populated; a client's copy is populated only
   * for cards that client may see. Modelling it as nullable rather than
   * keeping a separate client type is what lets both sides run one reducer.
   */
  face: Face | null;
  /** Denormalised back-reference to the containing zone. Kept in step by the reducer. */
  zone: ZoneId;
  faceUp: boolean;
  /** Players granted a targeted look at this card -- Go Fish, showing a hand. */
  revealedTo: PlayerId[];
  /** Concurrency lock. Only the holder may move or flip the card. */
  heldBy: PlayerId | null;
  /** Bumped on every mutation, so clients can detect stale optimistic state. */
  version: number;
  /** Free placement within a `free` zone. Ignored for other layouts. */
  pos?: Point;
}

/**
 * How long a player's name may be.
 *
 * One number, because three places enforce it -- the field somebody types
 * into, the join, and the rename -- and only the last two are authoritative.
 * Three copies of a limit is three chances for the field to accept a name the
 * table then silently cuts short.
 *
 * Short on purpose: a name is read at a glance off a plate beside a hand, and
 * at a ten-seat table those plates sit shoulder to shoulder.
 */
export const MAX_NAME_LENGTH = 10;

export interface Player {
  id: PlayerId;
  name: string;
  seat: number;
  connected: boolean;
  /** The player who created the table may force undos and change options. */
  isOwner: boolean;
}

export interface TableOptions {
  /** When false, anyone may look into anyone's hand. Useful for teaching games. */
  handsArePrivate: boolean;
  /** When false, only the table owner may shuffle. */
  anyoneMayShuffle: boolean;
  /** When true, only the player holding the turn may act on shared zones. */
  enforceTurnOrder: boolean;
  /** Seconds an unattended grab lock survives before the server releases it. */
  grabLockTtlMs: number;
  /** Window within which a player may undo their own last action. */
  undoWindowMs: number;
}

export const DEFAULT_OPTIONS: TableOptions = {
  handsArePrivate: true,
  anyoneMayShuffle: true,
  enforceTurnOrder: false,
  grabLockTtlMs: 10_000,
  undoWindowMs: 10_000,
};

/**
 * A redeal waiting on the rest of the table.
 *
 * Dealing again mid-hand is not a neutral act: whoever asks for it has seen
 * their cards, and a table owner who can redeal at will can simply keep
 * dealing until the hand suits them. So it becomes a request. Everyone still
 * in the game has to agree, and one refusal ends it.
 */
export interface RedealProposal {
  by: PlayerId;
  /** Everyone whose answer is still wanted. */
  waitingOn: PlayerId[];
  /** Whether the deal that follows also clears the running scores. */
  reset: boolean;
}

export interface GameState {
  roomId: string;
  /** Sequence number of the last applied event. */
  seq: number;
  rulesetId: string;
  players: Record<PlayerId, Player>;
  /** Seating order around the table, clockwise. */
  seatOrder: PlayerId[];
  /**
   * Sides, for a game played in partnerships. Empty for every other game.
   *
   * Carried by the engine and read only by the ruleset that set it and by the
   * screens that show a score. Everything else about a table is per-player --
   * `scores`, `rankings`, `inPlay`, the turn -- and stays that way: a team is
   * a fact about who a result belongs to, not about who acts.
   */
  teams: PlayerId[][];
  zones: Record<ZoneId, Zone>;
  cards: Record<CardId, Card>;
  turn: PlayerId | null;
  scores: Record<PlayerId, number>;
  options: TableOptions;
  /** Free-form declarations: bids, calls, "gin". Newest last. */
  declarations: Declaration[];

  phase: Phase;
  match: MatchState;
  /**
   * The most recent play into a public zone.
   *
   * Held in state rather than worked out from the event stream on the client,
   * so that someone who reconnects mid-hand sees the same highlight as
   * everyone who watched it land.
   */
  lastPlay: LastPlay | null;
  /**
   * Who was dealt into the current game, in turn order.
   *
   * Distinct from `seatOrder` on purpose: somebody who arrives mid-hand has a
   * seat but no cards, and the turn must skip them until the next deal.
   */
  inPlay: PlayerId[];
  /** A redeal somebody has asked for and the table has not settled yet. */
  redeal: RedealProposal | null;
  /** Finishing order once the game is over. First out is first here. */
  rankings: PlayerId[];

  /**
   * Who put each card where it now sits, for every card outside a hand.
   *
   * The engine knows this already -- every move carries its actor -- and used
   * to throw it away, which left "who played that?" answerable only by
   * redoing the ruleset's own arithmetic in the UI: a trick holds one card per
   * player from the leader onwards, so you can count back from whoever played
   * last. That is a rule, and a rule reimplemented in the client is worse than
   * one the client cannot see.
   *
   * A card returning to a hand is dropped from this: it is nobody's play any
   * more, which is what the trump coming back out of लॅडीस's trump zone is.
   */
  playedBy: Record<CardId, PlayerId>;

  /**
   * A scratchpad the current ruleset owns and the engine only carries.
   *
   * Most of what a game needs can be read off the zones -- whose turn it is,
   * how many tricks someone has won, what is on the layout -- and anything
   * derivable should be derived rather than stored twice. This is for the
   * remainder: facts with nowhere else to live, like which suit is trump or
   * which stage of the deal a game is in. The engine never reads it.
   */
  gameData: Record<string, string | number | boolean>;
}

export interface Declaration {
  seq: number;
  by: PlayerId;
  text: string;
}

/** What one completed round was worth. Lower scores are better. */
export interface RoundResult {
  scores: Record<PlayerId, number>;
  /** Finishing order; whoever went out first is first. */
  rankings: PlayerId[];
}

/**
 * A run of rounds played by the same table.
 *
 * Kept in engine state rather than in the ruleset so that a late joiner and a
 * reconnecting player both get the running totals with their first snapshot,
 * the same as everything else.
 */
export interface MatchState {
  /** How many rounds this match is set to run. */
  rounds: number;
  /** Completed rounds, oldest first. */
  played: RoundResult[];
}

/** The cards most recently put down in public, so everyone can see the play. */
export interface LastPlay {
  cardIds: CardId[];
  by: PlayerId | null;
}

// --- accessors -------------------------------------------------------------
// `noUncheckedIndexedAccess` makes every record lookup optional. These helpers
// keep that honest at the boundary instead of scattering non-null assertions.

export function getCard(state: GameState, id: CardId): Card {
  const card = state.cards[id];
  if (!card) throw new Error(`unknown card: ${id}`);
  return card;
}

export function getZone(state: GameState, id: ZoneId): Zone {
  const zone = state.zones[id];
  if (!zone) throw new Error(`unknown zone: ${id}`);
  return zone;
}

export function tryCard(state: GameState, id: CardId): Card | undefined {
  return state.cards[id];
}

export function tryZone(state: GameState, id: ZoneId): Zone | undefined {
  return state.zones[id];
}

export function getPlayer(state: GameState, id: PlayerId): Player {
  const player = state.players[id];
  if (!player) throw new Error(`unknown player: ${id}`);
  return player;
}

/**
 * The side a player is on, as an index into `teams`, or -1 for a game without
 * sides.
 */
export function teamOf(state: GameState, playerId: PlayerId): number {
  return state.teams.findIndex((team) => team.includes(playerId));
}

/** Whether two players are on the same side. A game without sides has none. */
export function sameTeam(state: GameState, a: PlayerId, b: PlayerId): boolean {
  const side = teamOf(state, a);
  return side >= 0 && side === teamOf(state, b);
}

/** Everyone on a player's side except the player. Empty without sides. */
export function partnersOf(state: GameState, playerId: PlayerId): PlayerId[] {
  const side = teamOf(state, playerId);
  if (side < 0) return [];
  return (state.teams[side] ?? []).filter((id) => id !== playerId);
}

/** The zone holding a player's hand, by convention `hand:<playerId>`. */
export function handZoneId(playerId: PlayerId): ZoneId {
  return `hand:${playerId}`;
}

export const DEFAULT_MATCH: MatchState = { rounds: 1, played: [] };

/** Rank order for games that need one. Ace low, king high. */
export const RANK_ORDER: readonly Rank[] = [
  'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K',
] as const;

/** 1 for an ace through 13 for a king; 0 for a joker, which has no place. */
export function rankValue(rank: Rank): number {
  return RANK_ORDER.indexOf(rank) + 1;
}

/**
 * What a card is worth when counting up what someone was left holding: ace
 * one, pip cards their own number, jack eleven, queen twelve, king thirteen.
 *
 * The same as `rankValue` today, and deliberately a separate function anyway
 * -- rank order is about which card follows which, and card value is about
 * scoring. Plenty of games disagree about one while agreeing on the other.
 */
export function cardPoints(rank: Rank): number {
  if (rank === 'JOKER') return 0;
  return rankValue(rank);
}

export const TABLE_ZONE: ZoneId = 'table';
export const DECK_ZONE: ZoneId = 'deck';
export const DISCARD_ZONE: ZoneId = 'discard';
