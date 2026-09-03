import {
  Table,
  makeRng,
  type CardId,
  type GameState,
  type Intent,
  type PlayerId,
  type Rng,
  type ZoneId,
} from '../src/index.js';

export function newTable(playerNames: string[], seed = 1): Table {
  let clock = 1_700_000_000_000;
  const table = new Table({
    roomId: 'test',
    rng: makeRng(seed),
    now: () => clock++,
    strict: true,
  });
  table.create();
  for (const name of playerNames) table.addPlayer(name, name);
  return table;
}

export function zoneIds(state: GameState): ZoneId[] {
  return Object.keys(state.zones);
}

export function cardIds(state: GameState): CardId[] {
  return Object.keys(state.cards);
}

function pick<T>(items: readonly T[], rng: Rng): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(rng.next() * items.length)];
}

function pickSome<T>(items: readonly T[], rng: Rng, max: number): T[] {
  const count = 1 + Math.floor(rng.next() * max);
  const out: T[] = [];
  for (let i = 0; i < count; i++) {
    const item = pick(items, rng);
    if (item !== undefined && !out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * Build a plausible-but-arbitrary intent. Most will be legal; the ones that
 * are not get denied, which is itself worth exercising.
 */
export function randomIntent(state: GameState, actor: PlayerId, rng: Rng): Intent {
  const cards = cardIds(state);
  const zones = zoneIds(state);
  const players = state.seatOrder;
  const roll = rng.next();

  if (roll < 0.3) {
    return { type: 'move', cardIds: pickSome(cards, rng, 3), toZone: pick(zones, rng)! };
  }
  if (roll < 0.45) return { type: 'flip', cardIds: pickSome(cards, rng, 3) };
  if (roll < 0.55) return { type: 'grab', cardIds: pickSome(cards, rng, 2) };
  if (roll < 0.62) return { type: 'release', cardIds: pickSome(cards, rng, 2) };
  if (roll < 0.72) return { type: 'shuffle', zoneId: pick(zones, rng)! };
  if (roll < 0.82) {
    return {
      type: 'reveal',
      cardIds: pickSome(cards, rng, 2),
      to: rng.next() < 0.5 ? 'all' : pickSome(players, rng, 2),
    };
  }
  if (roll < 0.88) return { type: 'peek', cardIds: pickSome(cards, rng, 2) };
  if (roll < 0.95) return { type: 'deal', fromZone: 'deck', count: 1 + Math.floor(rng.next() * 3) };
  return { type: 'passTurn' };
}

/** Drive a table through `steps` random actions by random players. */
export function fuzz(table: Table, steps: number, seed: number): void {
  const rng = makeRng(seed);
  for (let i = 0; i < steps; i++) {
    const actor = table.state.seatOrder[Math.floor(rng.next() * table.state.seatOrder.length)];
    if (!actor) return;
    table.submit(actor, randomIntent(table.state, actor, rng));
  }
}
