/**
 * A live room: one `Table` plus the sockets watching it.
 *
 * Every mutation funnels through `submit`, which is synchronous from end to
 * end. That is deliberate -- Node runs one turn of the event loop at a time,
 * so as long as nothing here awaits mid-mutation, intents are serialised
 * against each other for free and two players cannot interleave halfway
 * through a move. If an await is ever needed inside this path, it needs an
 * explicit queue first.
 *
 * The room is also the only place that knows who may see what. `Table` holds
 * the full truth; nothing reaches a socket without passing through
 * `redactEvent` and `visibilityDelta` on the way out.
 */

import {
  Table,
  peekFaces,
  projectFor,
  redactEvent,
  visibilityDelta,
  visibleFaces,
  type CardId,
  type CursorPosition,
  type GameEvent,
  type Intent,
  type PlayerId,
  type ServerMessage,
} from '@patte/core';

export interface Socket {
  send(data: string): void;
  close(): void;
}

export class Connection {
  /** Faces already delivered to this client, so we only ever send the diff. */
  readonly sent = new Set<CardId>();
  cursor: CursorPosition | null = null;

  constructor(
    readonly playerId: PlayerId,
    readonly socket: Socket,
  ) {}

  send(message: ServerMessage): void {
    try {
      this.socket.send(JSON.stringify(message));
    } catch {
      // A socket that has gone away is handled by its own close event.
    }
  }
}

const CURSOR_FLUSH_MS = 50;

export class Room {
  readonly table: Table;
  readonly connections = new Map<PlayerId, Connection>();
  lastActivity = Date.now();

  /** When each currently-held card was grabbed, for TTL expiry. */
  private readonly heldSince = new Map<CardId, number>();
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly id: string,
    rulesetId?: string,
    rounds?: number,
  ) {
    this.table = new Table({
      roomId: id,
      rulesetId,
      strict: process.env.NODE_ENV !== 'production',
    });
    this.table.create();
    if (rounds !== undefined) {
      this.table.commit(null, [{ type: 'matchRoundsSet', rounds }]);
    }
  }

  get isEmpty(): boolean {
    return this.connections.size === 0;
  }

  // --- membership ----------------------------------------------------------

  join(playerId: PlayerId, name: string, socket: Socket): Connection {
    this.lastActivity = Date.now();

    // A reconnecting player takes back their own seat, hand intact. Their old
    // socket is dropped without a `playerLeft`, so nothing on the table moves.
    this.connections.get(playerId)?.socket.close();

    const events = this.table.addPlayer(playerId, name);
    const connection = new Connection(playerId, socket);
    this.connections.set(playerId, connection);

    this.sendWelcome(connection);
    // Everyone else needs to hear about the arrival; the newcomer already has
    // it in their snapshot.
    this.broadcast(events, { except: playerId });
    return connection;
  }

  /**
   * A socket has closed.
   *
   * `socket` names which one, and that matters more than it looks. Closing is
   * asynchronous, so a reconnecting player's *old* socket reports its close
   * only after the new one has already been registered. Acting on that
   * blindly tears down the connection that just replaced it, leaving a client
   * whose socket is open, who believes it is live, and who the server has
   * quietly stopped talking to. A close from a socket that is no longer the
   * current one is stale news and is ignored.
   */
  leave(playerId: PlayerId, socket?: Socket): void {
    const connection = this.connections.get(playerId);
    if (!connection) return;
    if (socket && connection.socket !== socket) return; // superseded; not a departure

    this.connections.delete(playerId);
    this.lastActivity = Date.now();
    // The seat and hand are kept so the player can come back to them; only
    // their locks are dropped, so nobody is left unable to touch a card.
    this.broadcast(this.table.setConnected(playerId, false));
  }

  /** Vacate a seat for good, returning nothing to the table. */
  evict(playerId: PlayerId): void {
    this.connections.delete(playerId);
    this.broadcast(this.table.removePlayer(playerId));
  }

  private sendWelcome(connection: Connection): void {
    const snapshot = projectFor(this.table.state, connection.playerId);
    connection.sent.clear();
    for (const cardId of visibleFaces(this.table.state, connection.playerId)) {
      connection.sent.add(cardId);
    }
    connection.send({ t: 'welcome', version: 1, you: connection.playerId, snapshot });
  }

  resync(playerId: PlayerId): void {
    const connection = this.connections.get(playerId);
    if (connection) this.sendWelcome(connection);
  }

  // --- action --------------------------------------------------------------

  submit(playerId: PlayerId, requestId: number, intent: Intent): void {
    this.lastActivity = Date.now();
    const connection = this.connections.get(playerId);

    const result = this.table.submit(playerId, intent);
    if (!result.ok) {
      connection?.send({ t: 'denied', id: requestId, reason: result.reason });
      return;
    }

    this.trackLocks(result.events);
    this.broadcast(result.events, { ack: { playerId, requestId } });

    // A peek is answered privately and left out of state entirely, so there is
    // no copy of it on another client to leak. The rest of the table is told
    // that a peek happened -- the tell survives, the information does not.
    if (intent.type === 'peek') {
      connection?.send({ t: 'peeked', faces: peekFaces(this.table.state, intent.cardIds) });
    }
  }

  private trackLocks(events: GameEvent[]): void {
    for (const event of events) {
      if (event.type === 'cardsGrabbed') {
        for (const id of event.cardIds) this.heldSince.set(id, event.at);
      } else if (event.type === 'cardsReleased') {
        for (const id of event.cardIds) this.heldSince.delete(id);
      }
    }
  }

  /** Called on a timer: drop locks whose holder wandered off mid-drag. */
  sweepLocks(): void {
    const events = this.table.expireLocks(this.heldSince);
    if (events.length === 0) return;
    this.trackLocks(events);
    this.broadcast(events);
  }

  // --- fan-out -------------------------------------------------------------

  /**
   * Send events onward, each client seeing only its own version.
   *
   * The visibility diff is computed *after* the events are applied, so a move
   * that changes what someone may see carries the newly-permitted faces in the
   * same batch. The client therefore never renders a card it is entitled to
   * see as a blank back, and never holds a face it has lost the right to.
   */
  broadcast(events: GameEvent[], opts: { except?: PlayerId; ack?: { playerId: PlayerId; requestId: number } } = {}): void {
    if (events.length === 0) return;

    for (const connection of this.connections.values()) {
      if (opts.except === connection.playerId) continue;

      const delta = visibilityDelta(this.table.state, connection.playerId, connection.sent);
      for (const patch of delta.learn) connection.sent.add(patch.cardId);
      for (const cardId of delta.forget) connection.sent.delete(cardId);

      connection.send({
        t: 'events',
        events: events.map((event) => redactEvent(this.table.state, event, connection.playerId)),
        learn: delta.learn,
        forget: delta.forget,
        ...(opts.ack?.playerId === connection.playerId ? { ack: opts.ack.requestId } : {}),
      });
    }
  }

  // --- presence ------------------------------------------------------------

  setCursor(playerId: PlayerId, cursor: Omit<CursorPosition, 'playerId'>): void {
    const connection = this.connections.get(playerId);
    if (!connection) return;
    connection.cursor = { playerId, ...cursor };
    this.scheduleCursorFlush();
  }

  private scheduleCursorFlush(): void {
    if (this.cursorTimer) return;
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = null;
      const cursors: CursorPosition[] = [];
      for (const connection of this.connections.values()) {
        if (connection.cursor) cursors.push(connection.cursor);
      }
      if (cursors.length === 0) return;
      for (const connection of this.connections.values()) {
        connection.send({
          t: 'cursors',
          cursors: cursors.filter((c) => c.playerId !== connection.playerId),
        });
      }
    }, CURSOR_FLUSH_MS);
  }

  dispose(): void {
    if (this.cursorTimer) clearTimeout(this.cursorTimer);
    for (const connection of this.connections.values()) connection.socket.close();
    this.connections.clear();
  }
}
