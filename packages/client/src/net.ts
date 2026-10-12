/**
 * The socket, and the reconciliation loop around it.
 *
 * The client keeps two things: the last state the server confirmed, and the
 * intents it has sent but not heard back about. What you see on screen is
 * always `confirmed + replay(pending)`. That makes reconciliation almost
 * nothing -- an acknowledged intent leaves the pending list because it is now
 * part of `confirmed`, and a denied one leaves because it never happened. Both
 * are the same line of code.
 */

import {
  PROTOCOL_VERSION,
  applyVisibilityDelta,
  emptyState,
  getRuleset,
  isPredictable,
  randomUuid,
  reduce,
  type ClientMessage,
  type GameEvent,
  type GameState,
  type Intent,
  type ServerMessage,
} from '@patte/core';
import { useStore } from './store.js';

const STORAGE_KEY = 'patte:playerId';
const RECONNECT_BASE_MS = 400;
const RECONNECT_MAX_MS = 8_000;
/**
 * How many times to try before waiting to be asked.
 *
 * Retrying forever is the wrong default in both directions. A tab left open on
 * a table nobody is at pokes the server every eight seconds for as long as the
 * tab exists -- which on a host that sleeps when idle is enough to keep it
 * awake indefinitely, at the owner's expense. And a person watching a spinner
 * that has been spinning for an hour is not being served by another attempt.
 *
 * Twenty attempts is a little over two minutes of trying, which covers every
 * ordinary blip. After that it stops and says so -- and picks straight back up
 * the moment there is a reason to think it would work, which is what
 * `resumeOn` below is for.
 */
const MAX_RECONNECT_ATTEMPTS = 20;
/**
 * How often to send a ping.
 *
 * The socket is otherwise silent whenever nobody is doing anything -- four
 * people thinking about their hands send nothing at all -- and silence is
 * indistinguishable from a dead connection, to us, to whatever is between us,
 * and to a host that stops an idle process. Thirty seconds is well inside the
 * usual sixty-second idle timeout of a proxy.
 */
const PING_MS = 30_000;
/** How long to wait for a welcome before admitting something is wrong. */
const JOIN_TIMEOUT_MS = 8_000;

/** A stable identity, so a refresh returns you to your seat and your hand. */
export function myPlayerId(): string {
  let id = localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = randomUuid();
    localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}

export interface CursorSend {
  x: number;
  y: number;
  zone?: string;
  dx?: number;
  dy?: number;
}

export class Connection {
  private socket: WebSocket | null = null;
  private nextRequestId = 1;
  private attempt = 0;
  private closing = false;
  private cursorPending: CursorSend | null = null;
  private cursorTimer: number | null = null;

  private joinTimer: number | null = null;
  private pingTimer: number | null = null;
  private retryTimer: number | null = null;
  private resuming: (() => void) | null = null;

  constructor(
    private readonly roomId: string,
    private readonly name: string,
    private readonly rulesetId?: string,
  ) {}

  connect(): void {
    this.closing = false;
    this.attempt = 0;
    this.listenForReasonsToRetry();
    this.open();
  }

  /**
   * Try again now, because something changed that makes it worth trying.
   *
   * Backing off is right while the reason for the failure is unknown, but a
   * tab coming back to the front or a network coming back up is news, and the
   * person who just unlocked their phone should not be made to sit through
   * whatever was left of the backoff -- or, worse, be told to reload because
   * the attempts ran out while they were away.
   */
  private listenForReasonsToRetry(): void {
    if (this.resuming) return;

    const resume = (): void => {
      if (this.closing || this.socket) return;
      if (document.visibilityState === 'hidden') return;
      this.attempt = 0;
      this.open();
    };

    this.resuming = resume;
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
  }

  private open(): void {
    // A retry that was already scheduled has been overtaken by this one.
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    // Never run two sockets at once. Both would say hello with the same player
    // id, and the server drops the older connection whenever a player rejoins
    // -- so each socket would knock the other down in turn, for ever.
    if (this.socket) {
      const stale = this.socket;
      this.socket = null;
      stale.close();
    }

    const url = new URL('/ws', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempt = 0;
      useStore.getState().setStatus('connected');
      this.startPinging();

      // If anything here throws, the hello never goes out and the table waits
      // forever with nothing on screen to explain why. A visible error beats a
      // spinner that never resolves.
      try {
        this.send({
          t: 'hello',
          version: PROTOCOL_VERSION,
          roomId: this.roomId,
          playerId: myPlayerId(),
          name: this.name,
          ...(this.rulesetId ? { rulesetId: this.rulesetId } : {}),
        });
      } catch (error) {
        useStore.getState().setStatus('error', `Could not join: ${describe(error)}`);
        return;
      }

      // The server should answer immediately. If it does not, say so rather
      // than leaving the spinner spinning.
      this.joinTimer = window.setTimeout(() => {
        if (useStore.getState().you === null) {
          useStore.getState().setStatus('error', 'The table did not answer. Check the code and try again.');
        }
      }, JOIN_TIMEOUT_MS);
    });

    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return; // from a socket we have moved on from
      this.receive(JSON.parse(event.data as string) as ServerMessage);
    });

    socket.addEventListener('close', () => {
      if (this.closing) return;
      // A socket that has already been replaced is reporting old news. Acting
      // on it would announce a disconnection that is not happening and start a
      // second reconnect, which is how one dropped socket turns into a loop.
      if (this.socket !== socket) return;

      this.socket = null;
      this.stopPinging();

      if (this.attempt >= MAX_RECONNECT_ATTEMPTS) {
        useStore
          .getState()
          .setStatus('error', 'Lost the connection. Check your network — this will retry when you come back.');
        return;
      }

      useStore.getState().setStatus('reconnecting');
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt++, RECONNECT_MAX_MS);
      this.retryTimer = window.setTimeout(() => {
        this.retryTimer = null;
        if (!this.closing) this.open();
      }, delay);
    });

    socket.addEventListener('error', () => socket.close());
  }

  /**
   * Keep the line warm.
   *
   * The server answers a ping with a pong and nothing else happens, which is
   * the point: it is traffic, and traffic is what tells everything in the
   * path -- proxies, and hosts that stop an idle process -- that this
   * connection is still in use.
   */
  private startPinging(): void {
    this.stopPinging();
    this.pingTimer = window.setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) this.send({ t: 'ping' });
    }, PING_MS);
  }

  /** Give up on the current attempt and anything queued behind it. */
  private stopRetrying(): void {
    if (this.joinTimer !== null) {
      clearTimeout(this.joinTimer);
      this.joinTimer = null;
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.stopPinging();
  }

  private stopPinging(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  disconnect(): void {
    this.closing = true;
    if (this.joinTimer !== null) {
      clearTimeout(this.joinTimer);
      this.joinTimer = null;
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.stopPinging();
    if (this.resuming) {
      window.removeEventListener('online', this.resuming);
      document.removeEventListener('visibilitychange', this.resuming);
      this.resuming = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  /**
   * Send an intent, and where possible apply it locally at once so the card
   * moves under the finger rather than a round trip later.
   */
  submit(intent: Intent): void {
    const id = this.nextRequestId++;
    const store = useStore.getState();
    if (store.confirmed && isPredictable(store.view ?? store.confirmed, intent)) {
      store.addPending({ id, intent });
    }
    this.send({ t: 'intent', id, intent });
  }

  /** Cursor updates are throttled to a frame; they are presence, not state. */
  moveCursor(cursor: CursorSend): void {
    this.cursorPending = cursor;
    if (this.cursorTimer !== null) return;
    this.cursorTimer = window.setTimeout(() => {
      this.cursorTimer = null;
      if (this.cursorPending) this.send({ t: 'cursor', ...this.cursorPending });
      this.cursorPending = null;
    }, 50);
  }

  /**
   * Surface the things that happen off-screen.
   *
   * A peek is the case that matters. The face stays private, but at a real
   * table you would see someone tilt a card up, and a game where people can
   * look at the deck unobserved is a different game. So the look is announced
   * even though the card is not.
   */
  private announce(events: readonly GameEvent[], state: GameState): void {
    const store = useStore.getState();
    const ruleset = getRuleset(state.rulesetId);

    for (const event of events) {
      if (event.type === 'cardsPeeked' && event.actor !== null && event.actor !== store.you) {
        const name = state.players[event.actor]?.name ?? 'Someone';
        store.toast(`${name} took a look at a card`);
      }

      // Whatever the game itself wants said. Asked of the ruleset rather than
      // worked out here: which events matter, and how they read, is the
      // game's business, not the transport's.
      const said = store.you ? ruleset.announce?.(state, event, store.you) : null;
      if (typeof said === 'string') store.declare(said);
      else if (said) store.declare(said.line, said.show);
    }
  }

  private receive(message: ServerMessage): void {
    const store = useStore.getState();

    switch (message.t) {
      case 'welcome': {
        if (this.joinTimer !== null) {
          clearTimeout(this.joinTimer);
          this.joinTimer = null;
        }
        store.onWelcome(message.you, message.snapshot);
        return;
      }

      case 'events': {
        let state = store.confirmed ?? emptyState(this.roomId);
        for (const event of message.events) state = reduce(state, event);
        state = applyVisibilityDelta(state, { learn: message.learn, forget: message.forget });
        store.onConfirmed(state, message.ack);
        this.announce(message.events, state);
        return;
      }

      case 'denied': {
        store.onDenied(message.id, message.reason);
        return;
      }

      case 'peeked': {
        store.onPeeked(message.faces);
        return;
      }

      case 'cursors': {
        store.setCursors(message.cursors);
        return;
      }

      case 'error': {
        // A refusal, not a blip. The table does not exist, or this client is
        // too old to be understood -- and either way the next twenty attempts
        // would be told exactly the same thing, while the reconnect running
        // between them replaced the server's explanation with a vaguer one of
        // our own. Stop, and let what the server said stand.
        this.closing = true;
        this.stopRetrying();
        store.setStatus('error', message.message);
        return;
      }

      case 'pong':
        return;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
