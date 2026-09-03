/**
 * A table: authoritative state plus its append-only event log.
 *
 * Lives in core rather than the server so that tests, the concurrency soak and
 * any future single-process mode drive exactly the same object the server
 * does. The server adds sockets, locks expiry and per-viewer redaction around
 * this; it adds no rules of its own.
 */

import { cryptoRng, type Rng } from './deck.js';
import type { Denied, EventBody, GameEvent, Intent } from './intents.js';
import { reduce, emptyState, checkInvariants } from './reduce.js';
import { resolve } from './resolve.js';
import { handZone } from './rulesets/freeplay.js';
import { getRuleset } from './rulesets/registry.js';
import type { Ruleset } from './rulesets/types.js';
import { DEFAULT_OPTIONS, type GameState, type PlayerId } from './state.js';

export interface TableConfig {
  roomId: string;
  /** Which game this table is for. Unknown ids fall back to free play. */
  rulesetId?: string;
  rng?: Rng;
  now?: () => number;
  /** Throw on any broken invariant instead of carrying on. On in development. */
  strict?: boolean;
}

export type Committed = { ok: true; events: GameEvent[] };
export type SubmitResult = Committed | Denied;

/** Guard against a ruleset whose `after` keeps producing follow-up events. */
const MAX_CASCADE = 16;

export class Table {
  state: GameState;
  readonly log: GameEvent[] = [];
  readonly ruleset: Ruleset;

  private readonly rng: Rng;
  private readonly now: () => number;
  private readonly strict: boolean;

  constructor(config: TableConfig) {
    this.ruleset = getRuleset(config.rulesetId);
    this.rng = config.rng ?? cryptoRng();
    this.now = config.now ?? (() => Date.now());
    this.strict = config.strict ?? false;
    this.state = emptyState(config.roomId);
    this.state.rulesetId = this.ruleset.id;
  }

  /**
   * Open the room. Called once, when it is created.
   *
   * A ruleset that deals itself (free play) gets its table straight away.
   * One that needs to know who is playing waits in `lobby` until somebody
   * starts it, because you cannot deal to players who have not arrived.
   */
  create(): GameEvent[] {
    const bodies: EventBody[] = [
      {
        type: 'tableCreated',
        zones: [],
        cards: [],
        options: { ...DEFAULT_OPTIONS },
        rulesetId: this.ruleset.id,
      },
    ];

    if (this.ruleset.autoStart) {
      const setup = this.ruleset.setup({ players: [], rng: this.rng, match: this.state.match });
      bodies.push({
        type: 'gameStarted',
        zones: setup.zones,
        cards: setup.cards,
        options: { ...DEFAULT_OPTIONS, ...setup.options },
        inPlay: [],
        firstTurn: setup.firstTurn ?? null,
      });
    }

    return this.commit(null, bodies);
  }

  addPlayer(playerId: PlayerId, name: string): GameEvent[] {
    const existing = this.state.players[playerId];
    if (existing) {
      return this.commit(null, [{ type: 'playerConnection', playerId, connected: true }]);
    }
    const seat = nextFreeSeat(this.state);
    const isOwner = this.state.seatOrder.length === 0;
    return this.commit(null, [
      { type: 'playerJoined', playerId, name, seat, isOwner, handZone: handZone(playerId) },
    ]);
  }

  setConnected(playerId: PlayerId, connected: boolean): GameEvent[] {
    if (!this.state.players[playerId]) return [];
    return this.commit(null, [{ type: 'playerConnection', playerId, connected }]);
  }

  removePlayer(playerId: PlayerId): GameEvent[] {
    if (!this.state.players[playerId]) return [];
    return this.commit(null, [{ type: 'playerLeft', playerId }]);
  }

  /** Release every grab lock older than the table's TTL. */
  expireLocks(heldSince: Map<string, number>): GameEvent[] {
    const cutoff = this.now() - this.state.options.grabLockTtlMs;
    const stale = Object.values(this.state.cards)
      .filter((card) => card.heldBy !== null && (heldSince.get(card.id) ?? 0) < cutoff)
      .map((card) => card.id);
    if (stale.length === 0) return [];
    return this.commit(null, [{ type: 'cardsReleased', cardIds: stale }]);
  }

  /** The one entry point for player action. */
  submit(actor: PlayerId, intent: Intent): SubmitResult {
    const outcome = resolve(this.state, intent, actor, { rng: this.rng, ruleset: this.ruleset });
    if (!outcome.ok) return outcome;
    return { ok: true, events: this.commit(actor, outcome.events) };
  }

  /**
   * Stamp bodies with a sequence number, apply them, and give the ruleset a
   * chance to react. Nothing else in the system may write to `state`.
   */
  commit(actor: PlayerId | null, bodies: EventBody[]): GameEvent[] {
    const committed: GameEvent[] = [];
    const queue = [...bodies];
    let cascades = 0;

    while (queue.length > 0) {
      const body = queue.shift()!;
      const event: GameEvent = { ...body, seq: this.state.seq + 1, at: this.now(), actor };
      this.state = reduce(this.state, event);
      this.log.push(event);
      committed.push(event);

      if (this.strict) {
        const problems = checkInvariants(this.state);
        if (problems.length) throw new Error(`invariant broken by ${event.type}: ${problems[0]}`);
      }

      const follow = this.ruleset.after(this.state, event);
      if (follow.length > 0) {
        if (++cascades > MAX_CASCADE) throw new Error(`${this.ruleset.id} cascaded past the limit`);
        queue.unshift(...follow);
      }
    }

    return committed;
  }

  /** Replay the log from empty. Used to verify that state is a pure function of the log. */
  replay(): GameState {
    let state = emptyState(this.state.roomId);
    for (const event of this.log) state = reduce(state, event);
    return state;
  }
}

function nextFreeSeat(state: GameState): number {
  const taken = new Set(Object.values(state.players).map((p) => p.seat));
  let seat = 0;
  while (taken.has(seat)) seat++;
  return seat;
}
