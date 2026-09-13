import {
  applyVisibilityDelta,
  emptyState,
  legalCards,
  projectFor,
  TAKE,
  TRICK_ZONE,
  callerOf,
  reduce,
  rowZoneId,
  saatAath,
  trickAwaitingCollection,
  type GameState,
  type ServerMessage,
} from '@patte/core';
import { describe, expect, it } from 'vitest';
import { Room } from '../src/room.js';

/**
 * A client, reconstructed purely from what came down the wire.
 *
 * This is the honest test of the whole design: if a client can rebuild its
 * view from the welcome snapshot plus a stream of events and face patches,
 * and that view matches what the server says it is entitled to -- exactly,
 * field for field -- then the reducer really is shared, the visibility deltas
 * really do close, and nothing extra is being sent.
 */
class FakeClient {
  state: GameState = emptyState('pending');
  readonly received: ServerMessage[] = [];
  readonly peeked: string[] = [];
  readonly denials: string[] = [];
  playerId = '';

  readonly socket = {
    send: (data: string) => this.handle(JSON.parse(data) as ServerMessage),
    close: () => {},
  };

  private handle(message: ServerMessage): void {
    this.received.push(message);
    switch (message.t) {
      case 'welcome':
        this.playerId = message.you;
        this.state = message.snapshot;
        return;
      case 'events':
        for (const event of message.events) this.state = reduce(this.state, event);
        this.state = applyVisibilityDelta(this.state, {
          learn: message.learn,
          forget: message.forget,
        });
        return;
      case 'peeked':
        for (const patch of message.faces) this.peeked.push(patch.cardId);
        return;
      case 'denied':
        this.denials.push(message.reason);
        return;
      default:
        return;
    }
  }

  /** Every face this client actually holds. */
  knownFaces(): Set<string> {
    return new Set(
      Object.values(this.state.cards)
        .filter((card) => card.face !== null)
        .map((card) => card.id),
    );
  }
}

function roomWith(names: string[]): { room: Room; clients: Record<string, FakeClient> } {
  const room = new Room('TEST');
  const clients: Record<string, FakeClient> = {};
  for (const name of names) {
    const client = new FakeClient();
    clients[name] = client;
    room.join(name, name, client.socket);
  }
  return { room, clients };
}

describe('room fan-out', () => {
  it('gives every client exactly the state it is entitled to', () => {
    const { room, clients } = roomWith(['ana', 'ben', 'cal']);

    room.submit('ana', 1, { type: 'shuffle', zoneId: 'deck' });
    room.submit('ana', 2, { type: 'deal', fromZone: 'deck', count: 5 });
    const anaCard = room.table.state.zones['hand:ana']!.cards[0]!;
    room.submit('ana', 3, { type: 'reveal', cardIds: [anaCard], to: ['ben'] });
    room.submit('ben', 4, { type: 'move', cardIds: [room.table.state.zones['hand:ben']!.cards[0]!], toZone: 'discard' });
    room.submit('cal', 5, { type: 'flip', cardIds: [room.table.state.zones['hand:cal']!.cards[0]!], faceUp: true });

    for (const [name, client] of Object.entries(clients)) {
      expect(client.state, `client ${name} diverged from its projection`).toEqual(
        projectFor(room.table.state, name),
      );
    }
  });

  it('never sends a client a face it may not see', () => {
    const { room, clients } = roomWith(['ana', 'ben']);
    room.submit('ana', 1, { type: 'deal', fromZone: 'deck', count: 5 });

    const benHand = room.table.state.zones['hand:ben']!.cards;
    // Not merely rendered as backs -- the data was never transmitted.
    for (const cardId of benHand) expect(clients['ana']!.knownFaces().has(cardId)).toBe(false);
    for (const cardId of benHand) expect(clients['ben']!.knownFaces().has(cardId)).toBe(true);

    const wire = JSON.stringify(clients['ana']!.received);
    const secret = room.table.state.cards[benHand[0]!]!.face!;
    expect(wire).not.toContain(`"rank":"${secret.rank}","suit":"${secret.suit}"`);
  });

  it('makes a client forget a face it has lost the right to', () => {
    const { room, clients } = roomWith(['ana', 'ben']);
    room.submit('ana', 1, { type: 'deal', fromZone: 'deck', count: 3 });
    const card = room.table.state.zones['hand:ana']!.cards[0]!;
    expect(clients['ana']!.knownFaces().has(card)).toBe(true);

    room.submit('ana', 2, { type: 'move', cardIds: [card], toZone: 'deck' });
    expect(clients['ana']!.knownFaces().has(card)).toBe(false);
  });

  it('answers a peek privately and broadcasts only the tell', () => {
    const { room, clients } = roomWith(['ana', 'ben']);
    const top = room.table.state.zones['deck']!.cards[0]!;
    room.submit('ana', 1, { type: 'peek', cardIds: [top] });

    expect(clients['ana']!.peeked).toEqual([top]);
    expect(clients['ben']!.peeked).toEqual([]);
    // Ben learns that Ana looked, but not at what.
    expect(clients['ben']!.received.some((m) => m.t === 'events' && m.events.some((e) => e.type === 'cardsPeeked'))).toBe(true);
    expect(clients['ben']!.knownFaces().has(top)).toBe(false);
  });

  it('acks the acting client and only the acting client', () => {
    const { room, clients } = roomWith(['ana', 'ben']);
    room.submit('ana', 77, { type: 'shuffle', zoneId: 'deck' });

    const anaBatch = clients['ana']!.received.findLast((m) => m.t === 'events');
    const benBatch = clients['ben']!.received.findLast((m) => m.t === 'events');
    expect(anaBatch!.t === 'events' && anaBatch.ack).toBe(77);
    expect(benBatch!.t === 'events' && benBatch.ack).toBeUndefined();
  });
});

describe('contention', () => {
  it('grants a contested card to exactly one player, every time', () => {
    const { room, clients } = roomWith(['ana', 'ben', 'cal']);
    const players = ['ana', 'ben', 'cal'];
    let grants = 0;

    for (let round = 0; round < 200; round++) {
      const card = room.table.state.zones['deck']!.cards[round % 40]!;
      const results = players.map((p) => {
        const before = room.table.state.cards[card]!.heldBy;
        room.submit(p, round, { type: 'grab', cardIds: [card] });
        return before === null && room.table.state.cards[card]!.heldBy === p;
      });
      expect(results.filter(Boolean)).toHaveLength(1);
      grants += 1;
      room.submit(room.table.state.cards[card]!.heldBy!, round, { type: 'release', cardIds: [card] });
    }

    expect(grants).toBe(200);
    // Two of the three are told why they lost, rather than silently ignored.
    expect(clients['ben']!.denials.length + clients['cal']!.denials.length).toBeGreaterThan(0);
    for (const [name, client] of Object.entries(clients)) {
      expect(client.state, `client ${name} diverged under contention`).toEqual(
        projectFor(room.table.state, name),
      );
    }
  });

  it('drops a walked-away players locks once the TTL passes', () => {
    const { room } = roomWith(['ana', 'ben']);
    const card = room.table.state.zones['deck']!.cards[0]!;
    room.submit('ana', 1, { type: 'grab', cardIds: [card] });
    expect(room.table.state.cards[card]!.heldBy).toBe('ana');

    room.sweepLocks();
    expect(room.table.state.cards[card]!.heldBy).toBe('ana'); // still fresh

    room.table.state.options.grabLockTtlMs = -1; // pretend the TTL has elapsed
    room.sweepLocks();
    expect(room.table.state.cards[card]!.heldBy).toBeNull();
  });
});

describe('reconnection', () => {
  it('survives a reload, where the old socket closes after the new one opens', () => {
    // The order that used to break this: the replacement connects first, and
    // only then does the old socket get round to reporting that it closed.
    const room = new Room('RECONN');
    const first = new FakeClient();
    room.join('ana', 'ana', first.socket);
    const other = new FakeClient();
    room.join('ben', 'ben', other.socket);

    const second = new FakeClient();
    room.join('ana', 'ana', second.socket); // the reload

    room.leave('ana', first.socket); // the stale close, arriving late

    expect(room.table.state.players['ana']!.connected).toBe(true);

    // And the reloaded client is still being talked to.
    const before = second.received.length;
    room.submit('ben', 1, { type: 'shuffle', zoneId: 'deck' });
    expect(second.received.length).toBeGreaterThan(before);
    expect(second.state).toEqual(projectFor(room.table.state, 'ana'));
  });

  it('still registers a genuine departure', () => {
    const room = new Room('BYE');
    const client = new FakeClient();
    room.join('ana', 'ana', client.socket);

    room.leave('ana', client.socket);
    expect(room.table.state.players['ana']!.connected).toBe(false);
    expect(room.isEmpty).toBe(true);
  });

  it('returns a player to their own seat with their hand intact', () => {
    const { room } = roomWith(['ana', 'ben']);
    room.submit('ana', 1, { type: 'deal', fromZone: 'deck', count: 5 });
    const handBefore = [...room.table.state.zones['hand:ana']!.cards];

    room.leave('ana');
    expect(room.table.state.players['ana']!.connected).toBe(false);
    expect(room.table.state.zones['hand:ana']!.cards).toEqual(handBefore);

    const returning = new FakeClient();
    room.join('ana', 'ana', returning.socket);
    expect(room.table.state.players['ana']!.connected).toBe(true);
    expect(returning.state).toEqual(projectFor(room.table.state, 'ana'));
    expect(returning.knownFaces().size).toBeGreaterThanOrEqual(5);
  });
});

/**
 * Seats, and when they stop being yours.
 *
 * Free play deals the moment the table exists, so none of this is reachable
 * there -- which is exactly why it went unnoticed until three people tried to
 * sit down for a game that waits in a lobby first.
 */
describe('holding a seat', () => {
  function lobby(names: string[]): { room: Room; clients: Record<string, FakeClient> } {
    const room = new Room('LOBBY', 'pach-tin-don');
    const clients: Record<string, FakeClient> = {};
    for (const name of names) {
      const client = new FakeClient();
      room.join(name, name, client.socket);
      clients[name] = client;
    }
    return { room, clients };
  }

  it('frees the chair when somebody closes their tab in the lobby', () => {
    const { room, clients } = lobby(['ana', 'ben']);
    expect(room.table.state.phase).toBe('lobby');

    room.leave('ben', clients['ben']!.socket);

    // Not "here but away": gone. There is no hand to come back to, and the
    // chair is the only thing they were holding.
    expect(room.table.state.players['ben']).toBeUndefined();
    expect(room.table.state.seatOrder).toEqual(['ana']);
  });

  it('lets the player who was waiting take the seat', () => {
    // The reported bug, start to finish: two sit down, one gives up and
    // closes their tab, and the third arrives to find the table unstartable.
    const { room, clients } = lobby(['ana', 'ben']);
    room.leave('ben', clients['ben']!.socket);

    room.join('cal', 'cal', new FakeClient().socket);
    room.join('dee', 'dee', new FakeClient().socket);

    expect(room.table.state.seatOrder).toEqual(['ana', 'cal', 'dee']);
    const started = room.table.submit('ana', { type: 'startGame' });
    expect(started.ok, started.ok ? '' : started.reason).toBe(true);
  });

  it('keeps the chair once the cards are out', () => {
    const { room, clients } = lobby(['ana', 'ben', 'cal']);
    const started = room.table.submit('ana', { type: 'startGame' });
    expect(started.ok).toBe(true);

    room.leave('ben', clients['ben']!.socket);

    // Mid-hand they hold cards, tricks and a turn. Taking the seat away would
    // be taking the game away from somebody whose phone went to sleep.
    expect(room.table.state.players['ben']?.connected).toBe(false);
    expect(room.table.state.zones['hand:ben']?.cards).toHaveLength(5);
    expect(room.table.state.seatOrder).toContain('ben');
  });

  it('passes ownership on when the owner gives up their chair', () => {
    const { room, clients } = lobby(['ana', 'ben']);
    expect(room.table.state.players['ana']?.isOwner).toBe(true);

    room.leave('ana', clients['ana']!.socket);

    // Otherwise the table is left with nobody who may set the match length,
    // end the match or ask for a redeal -- and no way to appoint one.
    expect(room.table.state.players['ben']?.isOwner).toBe(true);
  });

  it('knows a full table from one with room', () => {
    const { room } = lobby(['ana', 'ben']);
    expect(room.isFull).toBe(false);

    room.join('cal', 'cal', new FakeClient().socket);
    expect(room.isFull).toBe(true);

    // A newcomer is turned away; somebody already seated is reconnecting and
    // must not be, however full the table is.
    expect(room.isNewcomer('dee')).toBe(true);
    expect(room.isNewcomer('ana')).toBe(false);
  });
});

describe('a refereed room', () => {
  it('waits in the lobby and deals only when started', () => {
    const room = new Room('SEVN', 'sevens');
    const clients: Record<string, FakeClient> = {};
    for (const name of ['ana', 'ben', 'cal']) {
      const client = new FakeClient();
      clients[name] = client;
      room.join(name, name, client.socket);
    }

    expect(room.table.state.phase).toBe('lobby');
    room.submit('ana', 1, { type: 'startGame' });
    expect(room.table.state.phase).toBe('playing');

    // Each client holds its own hand and nothing else, straight off the wire.
    for (const [name, client] of Object.entries(clients)) {
      expect(client.state).toEqual(projectFor(room.table.state, name));
      const mine = room.table.state.zones[`hand:${name}`]!.cards;
      const known = client.knownFaces();
      for (const cardId of mine) expect(known.has(cardId)).toBe(true);
      expect(known.size).toBe(mine.length);
    }
  });

  it('never puts an opponent’s hand on the wire during a whole game', () => {
    const room = new Room('SEVN2', 'sevens');
    const clients: Record<string, FakeClient> = {};
    for (const name of ['ana', 'ben', 'cal']) {
      const client = new FakeClient();
      clients[name] = client;
      room.join(name, name, client.socket);
    }
    room.submit('ana', 1, { type: 'startGame' });

    // Ana's hand at the deal: none of it may appear in Ben's byte stream at
    // any point before the game ends and hands are turned over.
    const anaHand = [...room.table.state.zones['hand:ana']!.cards];
    let request = 2;

    while (room.table.state.phase === 'playing' && request < 400) {
      const actor = room.table.state.turn!;
      const playable = legalCards(room.table.state, actor);
      if (playable[0]) {
        const suit = room.table.state.cards[playable[0]]!.face!.suit!;
        room.submit(actor, request++, { type: 'move', cardIds: [playable[0]], toZone: rowZoneId(suit) });
      } else {
        room.submit(actor, request++, { type: 'passTurn' });
      }

      if (room.table.state.phase !== 'playing') break;
      const stillHidden = anaHand.filter((id) => room.table.state.cards[id]!.zone === 'hand:ana');
      const benKnows = clients['ben']!.knownFaces();
      for (const cardId of stillHidden) {
        expect(benKnows.has(cardId), `${cardId} leaked to ben mid-game`).toBe(false);
      }
    }

    expect(room.table.state.phase).toBe('finished');
    for (const [name, client] of Object.entries(clients)) {
      expect(client.state, `${name} diverged`).toEqual(projectFor(room.table.state, name));
    }
  });

  it('refuses an illegal play over the wire, with a reason', () => {
    const room = new Room('SEVN3', 'sevens');
    const clients: Record<string, FakeClient> = {};
    for (const name of ['ana', 'ben', 'cal']) {
      const client = new FakeClient();
      clients[name] = client;
      room.join(name, name, client.socket);
    }
    room.submit('ana', 1, { type: 'startGame' });

    const waiting = ['ana', 'ben', 'cal'].find((p) => p !== room.table.state.turn)!;
    const card = room.table.state.zones[`hand:${waiting}`]!.cards[0]!;
    const suit = room.table.state.cards[card]!.face!.suit!;

    room.submit(waiting, 99, { type: 'move', cardIds: [card], toZone: rowZoneId(suit) });
    expect(clients[waiting]!.denials.at(-1)).toMatch(/your turn/);
    expect(room.table.state.cards[card]!.zone).toBe(`hand:${waiting}`);
  });
});

describe('a trick-taking room', () => {
  function seated(): { room: Room; clients: Record<string, FakeClient> } {
    const room = new Room('SAAT', 'saat-aath');
    const clients: Record<string, FakeClient> = {};
    for (const name of ['ana', 'ben']) {
      const client = new FakeClient();
      clients[name] = client;
      room.join(name, name, client.socket);
    }
    room.submit('ana', 1, { type: 'startGame' });
    return { room, clients };
  }

  it('sends nobody a buried stack card, all round long', () => {
    const { room, clients } = seated();
    const caller = callerOf(room.table.state)!;
    room.submit(caller, 2, { type: 'choose', option: 'H' });

    let request = 3;
    while (room.table.state.phase === 'playing' && request < 400) {
      // A decided trick has to be picked up before play carries on.
      const waiting = trickAwaitingCollection(room.table.state);
      if (waiting) {
        room.submit(waiting, request++, { type: 'choose', option: TAKE });
        continue;
      }

      const actor = room.table.state.turn!;
      const options = saatAath.legalCards!(room.table.state, actor);
      if (options.length === 0) break;
      room.submit(actor, request++, { type: 'move', cardIds: [options[0]!], toZone: TRICK_ZONE });

      // Anything face down -- buried under a stack, or gathered into a pile
      // of won tricks -- belongs to nobody's eyes.
      const buried = Object.values(room.table.state.zones)
        .filter((zone) => zone.kind === 'stack' || zone.kind === 'pile')
        .flatMap((zone) => zone.cards)
        .filter((cardId) => !room.table.state.cards[cardId]!.faceUp);

      for (const [name, client] of Object.entries(clients)) {
        const known = client.knownFaces();
        for (const cardId of buried) {
          expect(known.has(cardId), `${cardId} leaked to ${name} while still buried`).toBe(false);
        }
      }
    }

    expect(room.table.state.phase).toBe('finished');
    for (const [name, client] of Object.entries(clients)) {
      expect(client.state, `${name} diverged`).toEqual(projectFor(room.table.state, name));
    }
  });

  it('keeps a hand private and refuses a play from the wrong player', () => {
    const { room, clients } = seated();
    const caller = callerOf(room.table.state)!;
    const dealer = ['ana', 'ben'].find((p) => p !== caller)!;

    // The dealer cannot call trump...
    room.submit(dealer, 2, { type: 'choose', option: 'S' });
    expect(clients[dealer]!.denials.at(-1)).toMatch(/other player calls trump/);

    room.submit(caller, 3, { type: 'choose', option: 'S' });

    // ...nor play before it is their turn.
    const theirCard = room.table.state.zones[`hand:${dealer}`]!.cards[0]!;
    room.submit(dealer, 4, { type: 'move', cardIds: [theirCard], toZone: TRICK_ZONE });
    expect(clients[dealer]!.denials.at(-1)).toMatch(/your turn/);

    // And neither sees the other's hand.
    for (const [name, other] of [['ana', 'ben'], ['ben', 'ana']] as const) {
      for (const cardId of room.table.state.zones[`hand:${other}`]!.cards) {
        expect(clients[name]!.knownFaces().has(cardId)).toBe(false);
      }
    }
  });
});
