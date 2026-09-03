import { describe, expect, it } from 'vitest';
import {
  CARRIES_FACES,
  canSeeFace,
  projectFor,
  redactEvent,
  visibilityDelta,
  visibleFaces,
  type GameState,
  type PlayerId,
} from '../src/index.js';
import { fuzz, newTable } from './helpers.js';

/**
 * The anti-cheat guarantee, asserted directly: whatever a viewer is handed,
 * every face in it is a face they were entitled to. If this test is sound and
 * passing, no client can learn a card it should not know, regardless of what
 * the UI does.
 */
function assertNoLeak(state: GameState, viewer: PlayerId | null): void {
  const view = projectFor(state, viewer);
  for (const card of Object.values(view.cards)) {
    if (card.face === null) continue;
    expect(
      canSeeFace(state, state.cards[card.id]!, viewer),
      `leaked ${card.id} (${card.face.suit}${card.face.rank}) to ${viewer ?? 'spectator'}`,
    ).toBe(true);
  }
}

describe('projectFor', () => {
  it('hides other players hands and shows your own', () => {
    const table = newTable(['ana', 'ben']);
    table.submit('ana', { type: 'deal', fromZone: 'deck', count: 5 });

    const anaView = projectFor(table.state, 'ana');
    const anaHand = anaView.zones['hand:ana']!.cards;
    const benHand = anaView.zones['hand:ben']!.cards;

    expect(anaHand).toHaveLength(5);
    expect(benHand).toHaveLength(5);
    // Ana knows what she holds...
    for (const id of anaHand) expect(anaView.cards[id]!.face).not.toBeNull();
    // ...and knows only that Ben holds five cards.
    for (const id of benHand) expect(anaView.cards[id]!.face).toBeNull();
  });

  it('hides the deck from everyone, including the dealer', () => {
    const table = newTable(['ana', 'ben']);
    table.submit('ana', { type: 'shuffle', zoneId: 'deck' });
    const view = projectFor(table.state, 'ana');
    for (const id of view.zones['deck']!.cards) expect(view.cards[id]!.face).toBeNull();
  });

  it('shows a face-up card to everyone, including spectators', () => {
    const table = newTable(['ana', 'ben']);
    table.submit('ana', { type: 'deal', fromZone: 'deck', count: 1 });
    const card = table.state.zones['hand:ana']!.cards[0]!;
    table.submit('ana', { type: 'flip', cardIds: [card], faceUp: true });

    for (const viewer of ['ana', 'ben', null] as const) {
      expect(projectFor(table.state, viewer).cards[card]!.face).not.toBeNull();
    }
  });

  it('honours a targeted reveal without telling the rest of the table', () => {
    const table = newTable(['ana', 'ben', 'cal']);
    table.submit('ana', { type: 'deal', fromZone: 'deck', count: 3 });
    const card = table.state.zones['hand:ana']!.cards[0]!;
    table.submit('ana', { type: 'reveal', cardIds: [card], to: ['ben'] });

    expect(projectFor(table.state, 'ben').cards[card]!.face).not.toBeNull();
    expect(projectFor(table.state, 'cal').cards[card]!.face).toBeNull();
    // Cal can see that Ana showed Ben *something*, exactly as at a real
    // table -- but not what it was.
    expect(projectFor(table.state, 'cal').cards[card]!.revealedTo).toEqual(['ben']);
  });

  it('takes a reveal back when the card returns to the deck', () => {
    const table = newTable(['ana', 'ben']);
    table.submit('ana', { type: 'deal', fromZone: 'deck', count: 3 });
    const card = table.state.zones['hand:ana']!.cards[0]!;
    table.submit('ana', { type: 'reveal', cardIds: [card], to: ['ben'] });
    expect(projectFor(table.state, 'ben').cards[card]!.face).not.toBeNull();

    table.submit('ana', { type: 'move', cardIds: [card], toZone: 'deck' });
    expect(projectFor(table.state, 'ben').cards[card]!.face).toBeNull();
  });

  it('opens every hand when the table turns privacy off', () => {
    const table = newTable(['ana', 'ben']);
    table.submit('ana', { type: 'deal', fromZone: 'deck', count: 4 });
    const benCard = table.state.zones['hand:ben']!.cards[0]!;

    expect(projectFor(table.state, 'ana').cards[benCard]!.face).toBeNull();
    table.submit('ana', { type: 'setOption', key: 'handsArePrivate', value: false });
    expect(projectFor(table.state, 'ana').cards[benCard]!.face).not.toBeNull();
  });

  it('never leaks a face, over thousands of random actions', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const table = newTable(['ana', 'ben', 'cal'], seed);
      fuzz(table, 120, seed);
      for (const viewer of ['ana', 'ben', 'cal', null] as const) {
        assertNoLeak(table.state, viewer);
      }
    }
  });

  it('redacts faces out of every event that carries them', () => {
    const table = newTable(['ana', 'ben']);
    table.submit('ana', { type: 'deal', fromZone: 'deck', count: 3 });

    const carriers = table.log.filter((event) => CARRIES_FACES.has(event.type));
    // If a new face-carrying event is added and not listed, this is the test
    // that notices: the log will contain cards that redaction never saw.
    for (const event of table.log) {
      if ('cards' in event && Array.isArray(event.cards) && event.cards.length > 0) {
        expect(CARRIES_FACES.has(event.type), `${event.type} carries faces but is not redacted`).toBe(true);
      }
    }

    expect(carriers.length).toBeGreaterThan(0);
    for (const event of carriers) {
      const redacted = redactEvent(table.state, event, 'ana');
      if (!('cards' in redacted)) throw new Error('unreachable');
      for (const card of redacted.cards) {
        // Ana keeps only what she is entitled to; the rest arrives blank.
        const entitled = canSeeFace(table.state, table.state.cards[card.id]!, 'ana');
        if (!entitled) expect(card.face).toBeNull();
      }
    }
  });
});

describe('visibilityDelta', () => {
  it('teaches a face once and takes it back when entitlement ends', () => {
    const table = newTable(['ana', 'ben']);
    table.submit('ana', { type: 'deal', fromZone: 'deck', count: 3 });

    const sent = new Set<string>();
    let delta = visibilityDelta(table.state, 'ana', sent);
    expect(delta.learn).toHaveLength(3);
    expect(delta.forget).toHaveLength(0);
    for (const patch of delta.learn) sent.add(patch.cardId);

    // Nothing new to say on a second pass.
    expect(visibilityDelta(table.state, 'ana', sent).learn).toHaveLength(0);

    const card = table.state.zones['hand:ana']!.cards[0]!;
    table.submit('ana', { type: 'move', cardIds: [card], toZone: 'deck' });
    delta = visibilityDelta(table.state, 'ana', sent);
    expect(delta.forget).toEqual([card]);
  });

  it('agrees with visibleFaces for every viewer', () => {
    const table = newTable(['ana', 'ben'], 7);
    fuzz(table, 80, 7);
    for (const viewer of ['ana', 'ben'] as const) {
      const delta = visibilityDelta(table.state, viewer, new Set());
      const ids = new Set(delta.learn.map((p) => p.cardId));
      expect(ids).toEqual(visibleFaces(table.state, viewer));
    }
  });
});
