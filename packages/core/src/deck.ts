/** Deck construction and deterministic shuffling. */

import type { Card, CardId, Face, Rank, Suit, ZoneId } from './state.js';

export const SUITS: readonly Suit[] = ['C', 'D', 'H', 'S'] as const;
export const RANKS: readonly Rank[] = [
  'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K',
] as const;

export function cardId(face: Face, copy = 0): CardId {
  const base = face.suit ? `${face.suit}${face.rank}` : `JOKER${copy}`;
  return copy > 0 && face.suit ? `${base}#${copy}` : base;
}

export interface DeckSpec {
  /** How many 52-card packs to combine. Pinochle and Canasta want two. */
  packs?: number;
  jokers?: number;
  /** Keep only these ranks. Omit for all thirteen. */
  ranks?: readonly Rank[];
  /**
   * Drop these specific cards after building.
   *
   * Stripped decks are usually describable by rank alone, but not always:
   * 7-8 keeps the seven of hearts and of spades while dropping the other two,
   * which no rank filter can express.
   */
  exclude?: readonly CardId[];
}

/** Build a fresh, unshuffled pack sitting face down in `zoneId`. */
export function buildDeck(zoneId: ZoneId, spec: DeckSpec = {}): Card[] {
  const packs = Math.max(1, spec.packs ?? 1);
  const jokers = Math.max(0, spec.jokers ?? 0);
  const ranks = spec.ranks ?? RANKS;
  const dropped = new Set(spec.exclude ?? []);
  const cards: Card[] = [];

  for (let pack = 0; pack < packs; pack++) {
    for (const suit of SUITS) {
      for (const rank of ranks) {
        const face: Face = { rank, suit };
        const id = cardId(face, pack);
        if (dropped.has(id)) continue;
        cards.push(newCard(id, face, zoneId));
      }
    }
  }

  for (let j = 0; j < jokers; j++) {
    const face: Face = { rank: 'JOKER', suit: null };
    cards.push(newCard(`JOKER${j}`, face, zoneId));
  }

  return cards;
}

function newCard(id: CardId, face: Face, zone: ZoneId): Card {
  return {
    id,
    face,
    zone,
    faceUp: false,
    revealedTo: [],
    heldBy: null,
    version: 0,
  };
}

// --- randomness ------------------------------------------------------------

export interface Rng {
  /** A float in [0, 1). */
  next(): number;
}

/**
 * mulberry32. Seeded so that tests and log replays are reproducible; the
 * server seeds from `crypto` in production. The reducer never sees an `Rng` --
 * randomness is resolved into the event before it is applied.
 */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

export function cryptoRng(): Rng {
  return { next: () => globalThis.crypto.getRandomValues(new Uint32Array(1))[0]! / 4294967296 };
}

/** Fisher-Yates. Returns a new array; the input is untouched. */
export function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const a = out[i]!;
    const b = out[j]!;
    out[i] = b;
    out[j] = a;
  }
  return out;
}
