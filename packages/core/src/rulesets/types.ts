/**
 * The seam between the table and a game.
 *
 * A ruleset never moves cards itself. It answers three questions -- how the
 * table is laid out, what is allowed right now, and what follows from what
 * just happened -- and the same engine carries out the result. Free play is
 * simply the ruleset that allows everything, which is why the sandbox and an
 * enforced game of Sevens sit on one code path rather than two.
 */

import type { Rng } from '../deck.js';
import type { Denied, EventBody, GameEvent, Intent } from '../intents.js';
import type {
  Card,
  CardId,
  GameState,
  MatchState,
  PlayerId,
  Rank,
  Suit,
  TableOptions,
  Zone,
  ZoneId,
} from '../state.js';

/** Suits left to right, and ranks within a suit left to right. */
export interface HandOrder {
  suits: readonly Suit[];
  ranks: readonly Rank[];
}

export interface SetupSpec {
  zones: Zone[];
  cards: Card[];
  options: Partial<TableOptions>;
  /** Who acts first. Null leaves the turn unset, as free play does. */
  firstTurn?: PlayerId | null;
  /** Opening values for the ruleset's scratchpad -- stage, dealer, and such. */
  gameData?: Record<string, string | number | boolean>;
}

export interface SetupContext {
  players: PlayerId[];
  rng: Rng;
  /**
   * The match so far.
   *
   * A game whose roles rotate needs to know which round this is: in 7-8 the
   * deal alternates, and the dealer's quota is the easier one.
   */
  match: MatchState;
}

export interface Score {
  playerId: PlayerId;
  label: string;
  value: number;
}

export type Verdict = { ok: true } | Denied;

export const ALLOW: Verdict = { ok: true };

export interface Ruleset {
  id: string;
  name: string;
  /** One line, shown when picking a game. */
  blurb: string;
  minPlayers: number;
  maxPlayers: number;

  /**
   * Whether the table deals itself the moment it is created.
   *
   * Free play does: there is nothing to wait for. A game with rules does not,
   * because it needs to know who is playing before it can deal to them.
   */
  autoStart: boolean;

  /**
   * Lay out the table and deal.
   *
   * Takes the `Rng` because dealing is the one part of a game that is
   * genuinely random. Everything downstream of this is deterministic, which is
   * what keeps the reducer pure and the log replayable.
   */
  setup(context: SetupContext): SetupSpec;

  /**
   * Game-level legality only. Structural guards -- grab locks, zone access,
   * ownership -- are enforced by the engine before this is ever called, so a
   * buggy ruleset cannot open a hole in them.
   */
  validate(state: GameState, intent: Intent, actor: PlayerId): Verdict;

  /**
   * Consequences of an applied event: passing the turn on, ending the game,
   * awarding points. Returned events are applied immediately after the
   * triggering one, in order.
   */
  after(state: GameState, event: GameEvent): EventBody[];

  /**
   * Which of a player's cards may legally be played right now.
   *
   * Exists so the client can light up the playable cards and grey out Pass
   * without reimplementing the rules. The engine never needs it -- `validate`
   * is what actually decides -- but a rule the player cannot see is a rule
   * that feels like a bug.
   */
  legalCards?(state: GameState, playerId: PlayerId): CardId[];

  /**
   * Where a card the player has picked up is allowed to go, right now.
   *
   * This is what lets a touch screen offer "play this" as a single tap: pick a
   * card, and if there is exactly one place it may go, the client can put it
   * there without asking the player to find that place and hit it with a thumb.
   *
   * Returning several is meaningful and deliberately supported -- a game where
   * a card may go to any of three piles must say so, and the client falls back
   * to asking, highlighting those zones and waiting for a tap on one. What it
   * must not do is return one destination when there are really two, because
   * the one-tap path would then play the card somewhere the player did not
   * choose.
   *
   * An empty list means the card cannot be played at all at the moment, which
   * is the honest answer for a card that is not in `legalCards`.
   */
  destinationsFor?(state: GameState, playerId: PlayerId, cardId: CardId): ZoneId[];

  /**
   * The order a player's own hand reads best in, left to right.
   *
   * Data rather than a comparator, because what it encodes is a fact about the
   * game and not an algorithm: Sevens builds its rows upward from the ace, so
   * a hand sorted ace-to-king lines up with the table in front of you, while
   * 7-8 is a trick-taking game where the ace is the highest card and a hand
   * reads best strongest-first.
   *
   * Sorting is a view of your own hand and nothing more -- the engine never
   * reorders a zone, so no ordering of yours is ever sent to anybody else. If
   * it were, an opponent could watch the sorted positions of the cards you
   * play and learn how they rank against each other.
   */
  handOrder?: HandOrder;

  scoreboard?(state: GameState): Score[];

  /**
   * Which way the scoreboard reads.
   *
   * Sevens scores what you were caught holding, so low wins. 7-8 scores how
   * far past your quota you got, so high wins. The scoreboard has no way to
   * guess, and guessing wrong makes it quietly say the opposite of the truth.
   */
  scoreDirection: 'low' | 'high';
  /** One line under the scoreboard explaining what the numbers are. */
  scoreNote: string;

  /**
   * The word on the pass button, when the game has passing at all.
   *
   * Omitted means there is none: in 7-8 you must always play a card, so
   * offering a button that can only ever be refused would be a lie.
   */
  passLabel?: string;

  /**
   * Who the game is waiting on for a decision that is not a card.
   *
   * Non-null means play is paused -- 7-8 pauses mid-deal for the trump call --
   * so the ordinary turn indicator should stand down rather than describe a
   * turn that is not happening yet.
   */
  awaitingChoice?(state: GameState): PlayerId | null;

  /**
   * A decision small enough to offer as a single button in the status bar,
   * rather than a panel over the table.
   *
   * Returns the button for `playerId` when it is theirs to press. Naming trump
   * is a real choice and gets a panel; picking up a trick you have already won
   * is an acknowledgement and gets a button.
   */
  inlineChoice?(state: GameState, playerId: PlayerId): { label: string; option: string } | null;

  /**
   * What to announce when a round ends.
   *
   * The default -- "so-and-so wins" from `rankings[0]` -- assumes there is
   * always exactly one winner. 7-8 can be drawn, so it says so itself.
   */
  roundSummary?(state: GameState): string;
}
