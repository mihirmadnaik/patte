/** Every game the table knows how to referee. */

import { freeplay } from './freeplay.js';
import { saatAath } from './saat-aath.js';
import { sevens } from './sevens.js';
import type { Ruleset } from './types.js';

/** Everything the engine can referee, free play included. */
export const RULESETS: readonly Ruleset[] = [freeplay, sevens, saatAath];

/**
 * The games a person may actually choose.
 *
 * Free play is deliberately absent rather than deleted. It is the *null*
 * ruleset -- the one that permits everything, which the refereed games are
 * defined as restrictions of -- so the engine is built on it and much of the
 * engine's test suite is written against it. Taking it out of the registry
 * would remove the base case; taking it out of this list simply stops
 * offering it, which is the actual intent, and is one line to undo.
 */
export const OFFERED_RULESETS: readonly Ruleset[] = [sevens, saatAath];

/** What a table plays when nobody said. */
export const DEFAULT_RULESET_ID = OFFERED_RULESETS[0]!.id;

export function getRuleset(id: string | undefined): Ruleset {
  return RULESETS.find((ruleset) => ruleset.id === id) ?? freeplay;
}

export function isRulesetId(id: string | undefined): boolean {
  return RULESETS.some((ruleset) => ruleset.id === id);
}

/** Whether this is a game somebody is allowed to ask for. */
export function isOfferedRulesetId(id: string | undefined): boolean {
  return OFFERED_RULESETS.some((ruleset) => ruleset.id === id);
}
