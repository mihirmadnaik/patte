/** Every game the table knows how to referee. */

import { freeplay } from './freeplay.js';
import { saatAath } from './saat-aath.js';
import { sevens } from './sevens.js';
import type { Ruleset } from './types.js';

export const RULESETS: readonly Ruleset[] = [freeplay, sevens, saatAath];

export const DEFAULT_RULESET_ID = freeplay.id;

export function getRuleset(id: string | undefined): Ruleset {
  return RULESETS.find((ruleset) => ruleset.id === id) ?? freeplay;
}

export function isRulesetId(id: string | undefined): boolean {
  return RULESETS.some((ruleset) => ruleset.id === id);
}
