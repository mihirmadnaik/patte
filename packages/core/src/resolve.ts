/**
 * Intent -> event.
 *
 * This is where ambiguity, randomness and hidden information are consumed.
 * "Toggle these" becomes an explicit face-up flag per card, "shuffle" becomes
 * a concrete permutation, "deal" becomes a list of placements. What comes out
 * the far side is deterministic, which is what keeps the reducer pure and the
 * log replayable.
 *
 * It is also where the *structural* rules live -- grab locks, zone access,
 * ownership, turn order. Those hold for every game ever played on this table,
 * so they are enforced here rather than delegated to a ruleset, and a buggy
 * ruleset cannot open a hole in them.
 */

import { shuffled, type Rng } from './deck.js';
import {
  deny,
  resolved,
  type CardFlip,
  type CardPlacement,
  type EventBody,
  type Intent,
  type Resolution,
} from './intents.js';
import { canSeeFace } from './project.js';
import type { Ruleset } from './rulesets/types.js';
import {
  getCard,
  getZone,
  tryCard,
  tryZone,
  type CardId,
  type GameState,
  type PlayerId,
  type Zone,
  type ZoneId,
} from './state.js';

export interface ResolveDeps {
  rng: Rng;
  ruleset: Ruleset;
}

export function resolve(
  state: GameState,
  intent: Intent,
  actor: PlayerId,
  deps: ResolveDeps,
): Resolution {
  if (!state.players[actor]) return deny('you are not seated at this table');

  const structural = checkStructural(state, intent, actor, deps);
  if (!structural.ok) return structural;

  const verdict = deps.ruleset.validate(state, intent, actor);
  if (!verdict.ok) return verdict;

  return build(state, intent, actor, deps);
}

// --- structural guards -----------------------------------------------------

/** May `actor` take a card out of this zone? */
function mayTakeFrom(zone: Zone, actor: PlayerId): boolean {
  // Sealed beats ownership: winnings are yours, which is precisely why you do
  // not get to take them back out again.
  if (zone.sealed) return false;
  if (zone.owner === null) return true;
  if (zone.owner === actor) return true;
  return zone.openToOthers;
}

/** May `actor` put a card into this zone? */
function mayPutInto(zone: Zone, actor: PlayerId): boolean {
  if (zone.owner === null) return true;
  if (zone.owner === actor) return true;
  // Handing a card to another player is normal; it lands face down in their
  // hand and they alone can see it.
  return zone.kind === 'hand' || zone.openToOthers;
}

function cardsOf(intent: Intent): CardId[] {
  return 'cardIds' in intent ? intent.cardIds : [];
}

/** Does this intent reach beyond the actor's own hand? */
function touchesShared(state: GameState, cardIds: CardId[], actor: PlayerId): boolean {
  return cardIds.some((id) => {
    const card = tryCard(state, id);
    if (!card) return true;
    const zone = tryZone(state, card.zone);
    return !zone || zone.owner !== actor;
  });
}

function checkStructural(
  state: GameState,
  intent: Intent,
  actor: PlayerId,
  deps: ResolveDeps,
): Resolution {
  const cardIds = cardsOf(intent);

  for (const id of cardIds) {
    if (!tryCard(state, id)) return deny(`no such card: ${id}`);
  }

  // Turn order, when the table has asked for it. Rearranging your own hand is
  // always allowed -- people tidy their cards out of turn at every real table.
  const turnGated: Intent['type'][] = ['move', 'flip', 'shuffle', 'reveal', 'deal', 'gather'];
  if (
    state.options.enforceTurnOrder &&
    state.turn !== null &&
    state.turn !== actor &&
    turnGated.includes(intent.type) &&
    (cardIds.length === 0 || touchesShared(state, cardIds, actor))
  ) {
    return deny('it is not your turn');
  }

  switch (intent.type) {
    case 'grab': {
      for (const id of cardIds) {
        const card = getCard(state, id);
        if (card.heldBy !== null && card.heldBy !== actor) {
          return deny('another player is holding that card');
        }
        if (!mayTakeFrom(getZone(state, card.zone), actor)) {
          return deny('you cannot reach into that zone');
        }
      }
      return { ok: true, events: [] };
    }

    case 'move':
    case 'flip': {
      for (const id of cardIds) {
        const card = getCard(state, id);
        if (card.heldBy !== null && card.heldBy !== actor) {
          return deny('another player is holding that card');
        }
        if (!mayTakeFrom(getZone(state, card.zone), actor)) {
          return deny('you cannot reach into that zone');
        }
      }
      if (intent.type === 'move') {
        const target = tryZone(state, intent.toZone);
        if (!target) return deny(`no such zone: ${intent.toZone}`);
        if (!mayPutInto(target, actor)) return deny('you cannot place cards there');
      }
      return { ok: true, events: [] };
    }

    case 'peek': {
      for (const id of cardIds) {
        const card = getCard(state, id);
        if (!mayTakeFrom(getZone(state, card.zone), actor)) {
          return deny('you cannot reach into that zone');
        }
      }
      return { ok: true, events: [] };
    }

    case 'reveal': {
      // You cannot show what you cannot see.
      for (const id of cardIds) {
        if (!canSeeFace(state, getCard(state, id), actor)) {
          return deny('you cannot see that card yourself');
        }
      }
      return { ok: true, events: [] };
    }

    case 'shuffle': {
      if (!tryZone(state, intent.zoneId)) return deny(`no such zone: ${intent.zoneId}`);
      const zone = getZone(state, intent.zoneId);
      if (zone.owner !== null && zone.owner !== actor) return deny('that is not yours to shuffle');
      if (!state.options.anyoneMayShuffle && zone.owner === null && !isOwner(state, actor)) {
        return deny('only the table owner may shuffle');
      }
      return { ok: true, events: [] };
    }

    case 'deal': {
      if (!tryZone(state, intent.fromZone)) return deny(`no such zone: ${intent.fromZone}`);
      if (intent.count <= 0) return deny('deal at least one card');
      return { ok: true, events: [] };
    }

    case 'setOption': {
      if (!isOwner(state, actor)) return deny('only the table owner may change options');
      return { ok: true, events: [] };
    }

    case 'setMatchRounds': {
      if (!isOwner(state, actor)) return deny('only the table owner may change the match length');
      if (!Number.isFinite(intent.rounds) || intent.rounds < 1) return deny('a match needs at least one round');
      if (intent.rounds < state.match.played.length) {
        return deny(`${state.match.played.length} rounds have already been played`);
      }
      if (intent.rounds > 50) return deny('50 rounds is plenty');
      return { ok: true, events: [] };
    }

    case 'endMatch': {
      if (!isOwner(state, actor)) return deny('only the table owner may end the match');
      return { ok: true, events: [] };
    }

    case 'choose': {
      // The engine has no idea what the options mean; it only checks that the
      // game is running and hands the choice to the ruleset to judge.
      if (state.phase !== 'playing') return deny('there is nothing to choose right now');
      if (!intent.option.trim()) return deny('no choice was made');
      return { ok: true, events: [] };
    }

    case 'startGame': {
      const seated = state.seatOrder.length;
      if (seated < deps.ruleset.minPlayers) {
        return deny(
          `${deps.ruleset.name} needs at least ${deps.ruleset.minPlayers} players — ${seated} here`,
        );
      }
      if (seated > deps.ruleset.maxPlayers) {
        return deny(`${deps.ruleset.name} takes at most ${deps.ruleset.maxPlayers} players`);
      }
      // Anyone may deal a waiting or finished table. Interrupting a game in
      // progress is nobody's call alone -- see `proposeRedeal`.
      if (state.phase === 'playing') {
        return deny('ask the table for a redeal instead');
      }
      return { ok: true, events: [] };
    }

    case 'proposeRedeal': {
      if (state.phase !== 'playing') return deny('there is no hand to redeal');
      if (!isOwner(state, actor)) return deny('only the table owner may ask for a redeal');
      if (state.redeal) return deny('the table is already deciding on a redeal');
      return { ok: true, events: [] };
    }

    case 'answerRedeal': {
      const proposal = state.redeal;
      if (!proposal) return deny('nobody has asked for a redeal');
      // The asker may withdraw; everybody else may answer once.
      if (actor !== proposal.by && !proposal.waitingOn.includes(actor)) {
        return deny('you have already answered');
      }
      return { ok: true, events: [] };
    }

    case 'setTurn': {
      if (state.options.enforceTurnOrder && state.turn !== null && state.turn !== actor) {
        if (!isOwner(state, actor)) return deny('it is not your turn to pass');
      }
      return { ok: true, events: [] };
    }

    default:
      return { ok: true, events: [] };
  }
}

function isOwner(state: GameState, actor: PlayerId): boolean {
  return state.players[actor]?.isOwner === true;
}

// --- event construction ----------------------------------------------------

function build(
  state: GameState,
  intent: Intent,
  actor: PlayerId,
  deps: ResolveDeps,
): Resolution {
  switch (intent.type) {
    case 'grab':
      return resolved({ type: 'cardsGrabbed', cardIds: intent.cardIds, by: actor });

    case 'release': {
      const mine = intent.cardIds.filter((id) => tryCard(state, id)?.heldBy === actor);
      if (mine.length === 0) return resolved();
      return resolved({ type: 'cardsReleased', cardIds: mine });
    }

    case 'move': {
      const planner = new Planner(state);
      const placements = intent.cardIds.map((id) =>
        planner.place(id, intent.toZone, intent.toIndex, intent.pos),
      );
      // Picking a card up and putting it down is one gesture; the lock is
      // taken and given back around it so a move needs no separate grab.
      const toGrab = intent.cardIds.filter((id) => tryCard(state, id)?.heldBy === null);
      const events: EventBody[] = [];
      if (toGrab.length) events.push({ type: 'cardsGrabbed', cardIds: toGrab, by: actor });
      events.push({ type: 'cardsMoved', placements });
      events.push({ type: 'cardsReleased', cardIds: intent.cardIds });
      return { ok: true, events };
    }

    case 'flip': {
      const flips: CardFlip[] = intent.cardIds.map((id) => ({
        cardId: id,
        faceUp: intent.faceUp ?? !getCard(state, id).faceUp,
      }));
      return resolved({ type: 'cardsFlipped', flips });
    }

    case 'shuffle': {
      const zone = getZone(state, intent.zoneId);
      return resolved({
        type: 'zoneShuffled',
        zoneId: zone.id,
        order: shuffled(zone.cards, deps.rng),
      });
    }

    case 'reveal': {
      const to = intent.to === 'all' ? [...state.seatOrder] : intent.to;
      return resolved({ type: 'cardsRevealed', cardIds: intent.cardIds, to });
    }

    case 'peek':
      return resolved({ type: 'cardsPeeked', cardIds: intent.cardIds, by: actor });

    case 'deal': {
      const source = getZone(state, intent.fromZone);
      const targets =
        intent.toZones ?? state.seatOrder.map((id) => `hand:${id}`).filter((z) => tryZone(state, z));
      if (targets.length === 0) return deny('nobody to deal to');

      const available = source.cards.length;
      const wanted = intent.count * targets.length;
      if (wanted > available) return deny(`only ${available} cards left in ${source.id}`);

      // Round the table one card at a time, the way a person deals.
      const planner = new Planner(state);
      const placements: CardPlacement[] = [];
      let top = 0;
      for (let round = 0; round < intent.count; round++) {
        for (const target of targets) {
          const cardId = source.cards[top++];
          if (!cardId) break;
          placements.push(planner.place(cardId, target));
        }
      }

      const events: EventBody[] = [{ type: 'cardsMoved', placements }];
      if (intent.faceUp !== undefined) {
        events.push({
          type: 'cardsFlipped',
          flips: placements.map((p) => ({ cardId: p.cardId, faceUp: intent.faceUp! })),
        });
      }
      return { ok: true, events };
    }

    case 'gather': {
      const target = tryZone(state, intent.toZone);
      if (!target) return deny(`no such zone: ${intent.toZone}`);
      const planner = new Planner(state);
      const placements: CardPlacement[] = [];
      for (const zone of Object.values(state.zones)) {
        if (zone.id === target.id) continue;
        for (const cardId of [...zone.cards]) placements.push(planner.place(cardId, target.id));
      }
      // Sweeping the table up turns every card face down and lets go of it --
      // including the ones already sitting in the target zone, which is why
      // this works off the whole pack rather than off what moved.
      const all = Object.keys(state.cards);
      if (all.length === 0) return resolved();

      const events: EventBody[] = [];
      if (placements.length > 0) events.push({ type: 'cardsMoved', placements });
      events.push({
        type: 'cardsFlipped',
        flips: all.map((cardId) => ({ cardId, faceUp: false })),
      });
      events.push({ type: 'cardsReleased', cardIds: all });
      return { ok: true, events };
    }

    case 'startGame':
      return { ok: true, events: dealEvents(state, deps, intent.reset === true) };

    case 'proposeRedeal': {
      const others = state.inPlay.filter((id) => id !== actor && state.players[id] !== undefined);
      // Nobody to ask is not the same as nobody agreeing. A solo table, or one
      // where everyone else has left, simply deals.
      if (others.length === 0) return { ok: true, events: dealEvents(state, deps, intent.reset === true) };
      return resolved({
        type: 'redealProposed',
        by: actor,
        waitingOn: others,
        reset: intent.reset === true,
      });
    }

    case 'answerRedeal': {
      const proposal = state.redeal;
      if (!proposal) return resolved({ type: 'redealWithdrawn' });

      // The asker answering their own question is them thinking better of it.
      if (actor === proposal.by) return resolved({ type: 'redealWithdrawn' });

      const answer: EventBody = { type: 'redealAnswered', playerId: actor, agree: intent.agree };
      if (!intent.agree) return { ok: true, events: [answer, { type: 'redealWithdrawn' }] };

      // Unanimous only when this was the last answer outstanding.
      const remaining = proposal.waitingOn.filter((id) => id !== actor);
      if (remaining.length > 0) return { ok: true, events: [answer] };
      return { ok: true, events: [answer, ...dealEvents(state, deps, proposal.reset)] };
    }

    case 'setMatchRounds':
      return resolved({ type: 'matchRoundsSet', rounds: Math.trunc(intent.rounds) });

    case 'endMatch':
      return resolved({ type: 'matchEnded' });

    case 'choose':
      return resolved({ type: 'chosen', by: actor, option: intent.option.trim().slice(0, 40) });

    case 'passTurn': {
      // Turns follow whoever was dealt in, not whoever is sitting down. A
      // player who joined mid-hand has a seat but no cards, and skipping them
      // is the only sensible thing to do until the next deal.
      const order = state.inPlay.length > 0 ? state.inPlay : state.seatOrder;
      if (order.length === 0) return resolved();
      const current = state.turn ? order.indexOf(state.turn) : -1;
      const next = order[(current + 1) % order.length] ?? null;
      return resolved({ type: 'turnSet', playerId: next });
    }

    case 'setTurn':
      return resolved({ type: 'turnSet', playerId: intent.playerId });

    case 'declare': {
      const text = intent.text.trim().slice(0, 120);
      if (!text) return resolved();
      return resolved({ type: 'declared', by: actor, text });
    }

    case 'adjustScore':
      return resolved({ type: 'scoreAdjusted', playerId: intent.playerId, delta: intent.delta });

    case 'setOption':
      return resolved({ type: 'optionSet', key: intent.key, value: intent.value });

    case 'rename': {
      const name = intent.name.trim().slice(0, 24);
      if (!name) return deny('a name cannot be empty');
      return resolved({ type: 'playerRenamed', playerId: actor, name });
    }
  }
}

/**
 * Works out insertion indices for a run of moves.
 *
 * The reducer applies placements strictly in order, removing each card from
 * its current zone before the next is considered. This mirrors that, so the
 * indices written into the event are the ones the reducer will actually use.
 */
class Planner {
  private readonly lengths = new Map<ZoneId, number>();
  private readonly nextIndex = new Map<ZoneId, number>();

  constructor(private readonly state: GameState) {}

  private lengthOf(zoneId: ZoneId): number {
    const cached = this.lengths.get(zoneId);
    if (cached !== undefined) return cached;
    return tryZone(this.state, zoneId)?.cards.length ?? 0;
  }

  place(
    cardId: CardId,
    toZone: ZoneId,
    toIndex?: number,
    pos?: { x: number; y: number },
  ): CardPlacement {
    const card = getCard(this.state, cardId);
    this.lengths.set(card.zone, Math.max(0, this.lengthOf(card.zone) - 1));

    const room = this.lengthOf(toZone);
    let index: number;
    if (toIndex === undefined) {
      index = room;
    } else {
      // A run of cards dropped at one index keeps its order rather than
      // reversing, which is what someone sliding a fan of cards expects.
      const want = this.nextIndex.get(toZone) ?? toIndex;
      index = Math.max(0, Math.min(want, room));
      this.nextIndex.set(toZone, index + 1);
    }
    this.lengths.set(toZone, room + 1);

    return pos ? { cardId, toZone, toIndex: index, pos } : { cardId, toZone, toIndex: index };
  }
}

/**
 * The events that put a fresh deal on the table.
 *
 * Shared by every path that can deal -- the first game, the next round, and a
 * redeal the table has agreed to -- because a deal that arrived by consent has
 * to be indistinguishable from any other. Two copies of this would be two
 * chances for them to drift.
 */
function dealEvents(state: GameState, deps: ResolveDeps, reset: boolean): EventBody[] {
  const players = [...state.seatOrder];
  const setup = deps.ruleset.setup({
    players,
    rng: deps.rng,
    match: state.match,
    previous: state.gameData,
  });
  const events: EventBody[] = [];

  if (reset) events.push({ type: 'matchReset' });
  // Starting a round the match has no room for extends it by one, so "play
  // another" always works without needing a separate step.
  const played = reset ? 0 : state.match.played.length;
  if (played >= state.match.rounds) {
    events.push({ type: 'matchRoundsSet', rounds: played + 1 });
  }

  events.push({
    type: 'gameStarted',
    zones: setup.zones,
    cards: setup.cards,
    options: { ...state.options, ...setup.options },
    inPlay: setup.inPlay ?? players,
    firstTurn: setup.firstTurn ?? null,
  });
  // Opening scratchpad values land after the deal, since `gameStarted` wipes it.
  for (const [key, value] of Object.entries(setup.gameData ?? {})) {
    events.push({ type: 'gameDataSet', key, value });
  }
  return events;
}
