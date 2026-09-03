/**
 * The reducer: `(state, event) -> state`.
 *
 * Pure, total and deterministic. It consults no clock, no randomness and no
 * hidden information -- every event handed to it is already fully resolved.
 * That is what lets the server and every client run the same code and agree,
 * and what lets the whole log be replayed from empty to reproduce live state.
 *
 * It copies the state up front and then mutates freely. A table is a few dozen
 * cards, so the copy is not worth optimising away for the clarity it buys.
 */

import { GameEvent } from './intents.js';
import {
  DEFAULT_OPTIONS,
  GameState,
  getCard,
  getZone,
  TABLE_ZONE,
  tryCard,
  tryZone,
  type CardId,
  type ZoneId,
} from './state.js';

export function emptyState(roomId: string): GameState {
  return {
    roomId,
    seq: 0,
    rulesetId: 'freeplay',
    players: {},
    seatOrder: [],
    zones: {},
    cards: {},
    turn: null,
    scores: {},
    options: { ...DEFAULT_OPTIONS },
    declarations: [],
    phase: 'lobby',
    inPlay: [],
    rankings: [],
    match: { rounds: 1, played: [] },
    lastPlay: null,
    gameData: {},
  };
}

export function reduce(prev: GameState, event: GameEvent): GameState {
  const state = structuredClone(prev) as GameState;
  state.seq = event.seq;
  apply(state, event);
  return state;
}

export function reduceAll(prev: GameState, events: GameEvent[]): GameState {
  return events.reduce(reduce, prev);
}

function apply(state: GameState, event: GameEvent): void {
  switch (event.type) {
    case 'gameStarted': {
      // A deal replaces the table rather than patching it: hands, piles and
      // rows all come from the ruleset's setup, so a second game cannot
      // inherit a stray card from the first.
      state.zones = {};
      state.cards = {};
      for (const zone of event.zones) state.zones[zone.id] = structuredClone(zone);
      for (const card of event.cards) {
        state.cards[card.id] = structuredClone(card);
        const zone = tryZone(state, card.zone);
        if (zone && !zone.cards.includes(card.id)) zone.cards.push(card.id);
      }
      state.options = { ...event.options };
      state.inPlay = [...event.inPlay];
      state.turn = event.firstTurn;
      state.phase = 'playing';
      state.rankings = [];
      state.lastPlay = null;
      // A fresh deal starts with a blank scratchpad; last round's trump suit
      // has no business surviving into this one.
      state.gameData = {};
      return;
    }

    case 'gameEnded': {
      state.phase = 'finished';
      state.rankings = [...event.rankings];
      state.turn = null;
      state.match.played.push({ scores: { ...event.scores }, rankings: [...event.rankings] });
      return;
    }

    case 'gameDataSet': {
      state.gameData[event.key] = event.value;
      return;
    }

    case 'chosen': {
      // The choice itself changes nothing; the ruleset decides what follows
      // and writes any consequence to `gameData`.
      return;
    }

    case 'matchRoundsSet': {
      state.match.rounds = Math.max(1, Math.trunc(event.rounds));
      return;
    }

    case 'matchReset': {
      state.match.played = [];
      state.rankings = [];
      return;
    }

    case 'matchEnded': {
      // Stopping early means the match runs to however many rounds actually
      // got played, so every "is the match over?" check is the same
      // comparison rather than a separate flag.
      state.match.rounds = Math.max(state.match.played.length, 0);
      state.phase = 'finished';
      state.turn = null;
      return;
    }

    case 'tableCreated': {
      state.rulesetId = event.rulesetId;
      state.options = { ...event.options };
      state.zones = {};
      state.cards = {};
      state.inPlay = [];
      state.rankings = [];
      state.phase = 'lobby';
      state.lastPlay = null;
      state.gameData = {};
      for (const zone of event.zones) state.zones[zone.id] = structuredClone(zone);
      for (const card of event.cards) {
        state.cards[card.id] = structuredClone(card);
        // The pack arrives as a flat list; filing each card into its zone here
        // keeps `zone.cards` the single authority on order.
        const zone = tryZone(state, card.zone);
        if (zone && !zone.cards.includes(card.id)) zone.cards.push(card.id);
      }
      return;
    }

    case 'playerJoined': {
      state.players[event.playerId] = {
        id: event.playerId,
        name: event.name,
        seat: event.seat,
        connected: true,
        isOwner: event.isOwner,
      };
      state.zones[event.handZone.id] = structuredClone(event.handZone);
      state.scores[event.playerId] ??= 0;
      if (!state.seatOrder.includes(event.playerId)) state.seatOrder.push(event.playerId);
      state.seatOrder.sort((a, b) => seatOf(state, a) - seatOf(state, b));
      return;
    }

    case 'playerLeft': {
      // The player's cards stay on the table; only the seat is vacated. A
      // player who drops mid-hand can rejoin and find their hand intact.
      releaseHeldBy(state, event.playerId);
      delete state.players[event.playerId];
      state.seatOrder = state.seatOrder.filter((id) => id !== event.playerId);
      // Someone who leaves mid-game stops taking turns, or the table waits
      // forever on a chair that is not coming back.
      const wasInPlay = state.inPlay.indexOf(event.playerId);
      state.inPlay = state.inPlay.filter((id) => id !== event.playerId);
      if (state.turn === event.playerId) {
        const order = state.inPlay.length > 0 ? state.inPlay : state.seatOrder;
        state.turn = order[wasInPlay >= 0 ? wasInPlay % Math.max(order.length, 1) : 0] ?? null;
      }
      return;
    }

    case 'playerConnection': {
      const player = state.players[event.playerId];
      if (!player) return;
      player.connected = event.connected;
      if (!event.connected) releaseHeldBy(state, event.playerId);
      return;
    }

    case 'playerRenamed': {
      const player = state.players[event.playerId];
      if (player) player.name = event.name;
      return;
    }

    case 'cardsGrabbed': {
      for (const id of event.cardIds) {
        const card = tryCard(state, id);
        if (!card) continue;
        card.heldBy = event.by;
        card.version += 1;
      }
      return;
    }

    case 'cardsReleased': {
      for (const id of event.cardIds) {
        const card = tryCard(state, id);
        if (!card) continue;
        card.heldBy = null;
        card.version += 1;
      }
      return;
    }

    case 'cardsMoved': {
      // Applied strictly in order: each card is removed from its current zone
      // before the next placement is computed. `resolve` builds indices under
      // the same assumption.
      for (const placement of event.placements) {
        const card = tryCard(state, placement.cardId);
        if (!card) continue;
        removeFrom(state, card.zone, card.id);
        const target = tryZone(state, placement.toZone) ?? getZone(state, TABLE_ZONE);
        const index = clamp(placement.toIndex, 0, target.cards.length);
        target.cards.splice(index, 0, card.id);
        card.zone = target.id;
        card.version += 1;
        if (placement.pos) card.pos = { ...placement.pos };
        else if (target.layout !== 'free') delete card.pos;
        // Leaving a zone drops targeted reveals: a card returned to the deck
        // is secret again to anyone who was merely shown it.
        if (target.kind === 'deck') card.revealedTo = [];
      }

      // Remember what was just put down in public. A card going into a hand
      // is somebody tidying up or being dealt to, and a card going into a pile
      // is a trick being gathered -- neither is a play, and highlighting them
      // as one points at the wrong thing.
      const played = event.placements.filter((placement) => {
        const kind = tryZone(state, placement.toZone)?.kind;
        return kind !== undefined && kind !== 'hand' && kind !== 'pile';
      });
      if (played.length > 0) {
        state.lastPlay = { cardIds: played.map((placement) => placement.cardId), by: event.actor };
      }
      return;
    }

    case 'cardsFlipped': {
      for (const flip of event.flips) {
        const card = tryCard(state, flip.cardId);
        if (!card) continue;
        card.faceUp = flip.faceUp;
        card.version += 1;
      }
      return;
    }

    case 'zoneShuffled': {
      const zone = tryZone(state, event.zoneId);
      if (!zone) return;
      zone.cards = [...event.order];
      for (const id of event.order) {
        const card = tryCard(state, id);
        if (!card) continue;
        card.revealedTo = [];
        card.version += 1;
      }
      return;
    }

    case 'cardsRevealed': {
      for (const id of event.cardIds) {
        const card = tryCard(state, id);
        if (!card) continue;
        for (const viewer of event.to) {
          if (!card.revealedTo.includes(viewer)) card.revealedTo.push(viewer);
        }
        card.version += 1;
      }
      return;
    }

    case 'cardsPeeked': {
      // A peek grants no lasting visibility -- the client is sent the faces
      // once and the fact of the peek is broadcast. Nothing in state changes
      // beyond the version bump that tells clients to re-render the tell.
      for (const id of event.cardIds) {
        const card = tryCard(state, id);
        if (card) card.version += 1;
      }
      return;
    }

    case 'turnSet': {
      state.turn = event.playerId;
      return;
    }

    case 'declared': {
      state.declarations.push({ seq: event.seq, by: event.by, text: event.text });
      return;
    }

    case 'scoreAdjusted': {
      state.scores[event.playerId] = (state.scores[event.playerId] ?? 0) + event.delta;
      return;
    }

    case 'optionSet': {
      (state.options as unknown as Record<string, boolean | number>)[event.key] = event.value;
      return;
    }
  }
}

// --- helpers ---------------------------------------------------------------

function seatOf(state: GameState, id: string): number {
  return state.players[id]?.seat ?? Number.MAX_SAFE_INTEGER;
}

function removeFrom(state: GameState, zoneId: ZoneId, cardId: CardId): void {
  const zone = tryZone(state, zoneId);
  if (!zone) return;
  const at = zone.cards.indexOf(cardId);
  if (at >= 0) zone.cards.splice(at, 1);
}

function releaseHeldBy(state: GameState, playerId: string): void {
  for (const card of Object.values(state.cards)) {
    if (card.heldBy === playerId) {
      card.heldBy = null;
      card.version += 1;
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

/**
 * Invariant check used by tests and by the server in development: every card
 * belongs to exactly one zone, and the zone lists agree with the back-refs.
 * Card conservation is the one property a card table must never violate.
 */
export function checkInvariants(state: GameState): string[] {
  const problems: string[] = [];
  const seen = new Map<CardId, ZoneId>();

  for (const zone of Object.values(state.zones)) {
    for (const cardId of zone.cards) {
      const existing = seen.get(cardId);
      if (existing) problems.push(`card ${cardId} is in both ${existing} and ${zone.id}`);
      seen.set(cardId, zone.id);
      if (!state.cards[cardId]) problems.push(`zone ${zone.id} lists unknown card ${cardId}`);
    }
  }

  for (const card of Object.values(state.cards)) {
    const where = seen.get(card.id);
    if (!where) problems.push(`card ${card.id} is in no zone`);
    else if (where !== card.zone) {
      problems.push(`card ${card.id} claims zone ${card.zone} but sits in ${where}`);
    }
  }

  return problems;
}

export { getCard, getZone };
