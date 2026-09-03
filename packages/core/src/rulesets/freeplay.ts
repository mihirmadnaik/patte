/**
 * Free play: the null ruleset.
 *
 * It imposes nothing. Every constraint a free-play table still has -- you may
 * only move a card you are holding, you may not reach into a private hand --
 * is structural and lives in the engine, because those rules are true of every
 * game, not just this one.
 *
 * That this file is nearly empty is the point. It is the proof that the
 * sandbox and a rule-enforced game are the same machine.
 */

import { buildDeck } from '../deck.js';
import {
  DECK_ZONE,
  DISCARD_ZONE,
  TABLE_ZONE,
  type PlayerId,
  type Zone,
} from '../state.js';
import { ALLOW, type Ruleset, type SetupContext, type SetupSpec, type Verdict } from './types.js';

export const sharedZones = (): Zone[] => [
  {
    id: DECK_ZONE,
    kind: 'deck',
    owner: null,
    layout: 'stack',
    faceDownVisibleTo: 'none',
    openToOthers: true,
    cards: [],
    pos: { x: 0.42, y: 0.44 },
    label: 'Deck',
  },
  {
    id: DISCARD_ZONE,
    kind: 'discard',
    owner: null,
    layout: 'stack',
    // An open pile: anything played here is visible to the whole table, the
    // way discards are at a real one. Without this a card you played would
    // vanish into a pile even you could not read. Note this is a property of
    // the zone, not a rule -- a face-down pile is still available, it is just
    // the table surface or the deck instead.
    faceDownVisibleTo: 'all',
    openToOthers: true,
    cards: [],
    pos: { x: 0.58, y: 0.44 },
    label: 'Discard',
  },
  {
    id: TABLE_ZONE,
    kind: 'table',
    owner: null,
    layout: 'free',
    faceDownVisibleTo: 'none',
    openToOthers: true,
    cards: [],
    pos: { x: 0.5, y: 0.5 },
    label: 'Table',
  },
];

export function handZone(playerId: PlayerId): Zone {
  return {
    id: `hand:${playerId}`,
    kind: 'hand',
    owner: playerId,
    layout: 'fan',
    faceDownVisibleTo: 'owner',
    openToOthers: false,
    cards: [],
  };
}

export const freeplay: Ruleset = {
  id: 'freeplay',
  name: 'Free play',
  blurb: 'A deck and a table. No rules, no turns — do whatever you like with it.',
  minPlayers: 1,
  maxPlayers: 8,
  autoStart: true,
  scoreDirection: 'low',
  scoreNote: 'Scores are whatever you choose to record.',

  setup({ players }: SetupContext): SetupSpec {
    return {
      zones: [...sharedZones(), ...players.map(handZone)],
      cards: buildDeck(DECK_ZONE),
      options: {},
    };
  },

  validate(): Verdict {
    return ALLOW;
  },

  after(): [] {
    return [];
  },
};
