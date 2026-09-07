/**
 * Dealing again, by agreement.
 *
 * The asker has seen their cards. Left unchecked, "redeal" is a way to keep
 * dealing until the hand suits you — so it stops being a command and becomes
 * a request that everyone still in the game has to grant.
 */

import { describe, expect, it } from 'vitest';
import {
  TABLE_INTENTS,
  TAKE,
  Table,
  callerOf,
  getRuleset,
  makeRng,
  saatAath,
  stageOf,
  trickAwaitingCollection,
  type GameState,
  type Intent,
  type PlayerId,
} from '../src/index.js';

const PLAYERS = ['ana', 'ben', 'cal'];

function playing(seed = 1, players = PLAYERS): Table {
  let clock = 1_700_000_000_000;
  const table = new Table({
    roomId: 'redeal',
    rulesetId: 'sevens',
    rng: makeRng(seed),
    now: () => clock++,
    strict: true,
  });
  table.create();
  for (const name of players) table.addPlayer(name, name);
  const started = table.submit(players[0]!, { type: 'startGame' });
  if (!started.ok) throw new Error(started.reason);
  return table;
}

/** Something to notice a redeal by: whose hand is whose. */
function handOf(table: Table, playerId: PlayerId): string[] {
  return [...(table.state.zones[`hand:${playerId}`]?.cards ?? [])];
}

describe('asking', () => {
  it('refuses a bare restart of a hand in progress', () => {
    const table = playing();
    const denied = table.submit('ana', { type: 'startGame' });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toMatch(/redeal/);
  });

  it('is the owner who may ask', () => {
    const table = playing();
    const denied = table.submit('ben', { type: 'proposeRedeal' });
    expect(denied.ok).toBe(false);
    expect(table.state.redeal).toBeNull();

    expect(table.submit('ana', { type: 'proposeRedeal' }).ok).toBe(true);
    expect(table.state.redeal).toEqual({ by: 'ana', waitingOn: ['ben', 'cal'], reset: false });
  });

  it('does not deal on the asking', () => {
    const table = playing();
    const before = handOf(table, 'ana');
    table.submit('ana', { type: 'proposeRedeal' });
    expect(handOf(table, 'ana')).toEqual(before);
  });

  it('refuses a second question while the first is open', () => {
    const table = playing();
    table.submit('ana', { type: 'proposeRedeal' });
    const denied = table.submit('ana', { type: 'proposeRedeal' });
    expect(denied.ok).toBe(false);
  });
});

describe('answering', () => {
  it('deals only once everybody has agreed', () => {
    const table = playing();
    const before = handOf(table, 'ana');
    table.submit('ana', { type: 'proposeRedeal' });

    expect(table.submit('ben', { type: 'answerRedeal', agree: true }).ok).toBe(true);
    // One agreement is not enough, and the cards have not moved.
    expect(table.state.redeal?.waitingOn).toEqual(['cal']);
    expect(handOf(table, 'ana')).toEqual(before);

    expect(table.submit('cal', { type: 'answerRedeal', agree: true }).ok).toBe(true);
    expect(table.state.redeal).toBeNull();
    expect(handOf(table, 'ana')).not.toEqual(before);
    expect(table.state.phase).toBe('playing');
  });

  it('one refusal ends it, and the hand plays on', () => {
    const table = playing();
    const before = handOf(table, 'ana');
    table.submit('ana', { type: 'proposeRedeal' });
    table.submit('ben', { type: 'answerRedeal', agree: true });

    expect(table.submit('cal', { type: 'answerRedeal', agree: false }).ok).toBe(true);
    expect(table.state.redeal).toBeNull();
    expect(handOf(table, 'ana')).toEqual(before);
  });

  it('lets the asker think better of it', () => {
    const table = playing();
    const before = handOf(table, 'ana');
    table.submit('ana', { type: 'proposeRedeal' });
    expect(table.submit('ana', { type: 'answerRedeal', agree: false }).ok).toBe(true);
    expect(table.state.redeal).toBeNull();
    expect(handOf(table, 'ana')).toEqual(before);
  });

  it('counts each player once', () => {
    const table = playing();
    table.submit('ana', { type: 'proposeRedeal' });
    table.submit('ben', { type: 'answerRedeal', agree: true });

    // Answering twice must not stand in for the player who has not answered.
    const denied = table.submit('ben', { type: 'answerRedeal', agree: true });
    expect(denied.ok).toBe(false);
    expect(table.state.redeal?.waitingOn).toEqual(['cal']);
  });

  it('has nothing to answer when nothing was asked', () => {
    const table = playing();
    const denied = table.submit('ben', { type: 'answerRedeal', agree: true });
    expect(denied.ok).toBe(false);
  });
});

describe('a table that changes mid-question', () => {
  it('drops the request when somebody leaves, rather than dealing without them', () => {
    const table = playing();
    const before = handOf(table, 'ana');
    table.submit('ana', { type: 'proposeRedeal' });
    table.submit('ben', { type: 'answerRedeal', agree: true });

    // Only 'cal' is still being waited on. If leaving counted as agreement,
    // the table would redeal on the strength of one player's answer.
    table.removePlayer('cal');
    expect(table.state.redeal).toBeNull();
    expect(handOf(table, 'ana')).toEqual(before);
  });
});

describe('a table of one', () => {
  it('deals straight away, because there is nobody to ask', () => {
    // Sevens wants two, so use the smallest table it will start.
    const table = playing(1, ['ana', 'ben']);
    table.removePlayer('ben');
    const before = handOf(table, 'ana');

    expect(table.submit('ana', { type: 'proposeRedeal' }).ok).toBe(true);
    expect(table.state.redeal).toBeNull();
    expect(handOf(table, 'ana')).not.toEqual(before);
  });
});

/**
 * Asking for a redeal at every point in a hand of 7-8.
 *
 * The first version of this feature worked in the trump call and was refused
 * during play as "not part of this game" -- because that ruleset states its
 * allowances stage by stage, and one of the stages had not been told about the
 * new intents. Each stage is exercised here, since testing one of them is
 * evidently no evidence about the others.
 */
describe('a redeal is answerable at any point in a hand of 7-8', () => {
  function table(seed = 1): Table {
    let clock = 1_700_000_000_000;
    const t = new Table({
      roomId: '78-redeal',
      rulesetId: 'saat-aath',
      rng: makeRng(seed),
      now: () => clock++,
      strict: true,
    });
    t.create();
    t.addPlayer('ana', 'Ana');
    t.addPlayer('ben', 'Ben');
    const started = t.submit('ana', { type: 'startGame' });
    if (!started.ok) throw new Error(started.reason);
    return t;
  }

  /** Ask, and have the other player agree. Returns nothing; throws on refusal. */
  function agreeRedeal(t: Table): void {
    const asked = t.submit('ana', { type: 'proposeRedeal' });
    if (!asked.ok) throw new Error(`asking: ${asked.reason}`);
    for (const playerId of [...(t.state.redeal?.waitingOn ?? [])]) {
      const answered = t.submit(playerId, { type: 'answerRedeal', agree: true });
      if (!answered.ok) throw new Error(`answering: ${answered.reason}`);
    }
  }

  it('during the trump call', () => {
    const t = table();
    expect(stageOf(t.state)).toBe('calling');
    agreeRedeal(t);
    expect(stageOf(t.state)).toBe('calling');
  });

  it('once the cards are in play', () => {
    const t = table();
    const called = t.submit(callerOf(t.state)!, { type: 'choose', option: 'S' });
    if (!called.ok) throw new Error(called.reason);
    expect(stageOf(t.state)).toBe('playing');

    // This is the case that was broken: play had started, and the ruleset's
    // play-stage switch listed the intents it allowed one by one.
    agreeRedeal(t);
    expect(stageOf(t.state)).toBe('calling');
  });

  it('with a decided trick still on the table', () => {
    const t = table();
    t.submit(callerOf(t.state)!, { type: 'choose', option: 'S' });
    for (let i = 0; i < 2; i++) {
      const actor = t.state.turn!;
      const card = saatAath.legalCards!(t.state, actor)[0]!;
      const played = t.submit(actor, { type: 'move', cardIds: [card], toZone: 'trick' });
      if (!played.ok) throw new Error(played.reason);
    }
    expect(trickAwaitingCollection(t.state)).toBeTruthy();

    agreeRedeal(t);
    expect(trickAwaitingCollection(t.state)).toBeNull();
  });

  it('and the trick can still be taken if the redeal is refused', () => {
    const t = table();
    t.submit(callerOf(t.state)!, { type: 'choose', option: 'S' });
    for (let i = 0; i < 2; i++) {
      const actor = t.state.turn!;
      t.submit(actor, { type: 'move', cardIds: [saatAath.legalCards!(t.state, actor)[0]!], toZone: 'trick' });
    }
    const winner = trickAwaitingCollection(t.state)!;

    t.submit('ana', { type: 'proposeRedeal' });
    const refused = t.submit(t.state.redeal!.waitingOn[0]!, { type: 'answerRedeal', agree: false });
    expect(refused.ok).toBe(true);

    const taken = t.submit(winner, { type: 'choose', option: TAKE });
    expect(taken.ok, taken.ok ? '' : taken.reason).toBe(true);
  });
});

describe('the table-level intents', () => {
  /** One of each, filled in enough to be validated. */
  const SAMPLES: Intent[] = [
    { type: 'startGame' },
    { type: 'proposeRedeal' },
    { type: 'answerRedeal', agree: true },
    { type: 'setMatchRounds', rounds: 2 },
    { type: 'endMatch' },
    { type: 'declare', text: 'hello' },
    { type: 'rename', name: 'Ana' },
  ];

  it('covers every intent this suite claims to cover', () => {
    expect(SAMPLES.map((intent) => intent.type).sort()).toEqual([...TABLE_INTENTS].sort());
  });

  it('is never answered with "not part of this game", by any ruleset in any stage', () => {
    // A ruleset decides what is a legal *move*. None of them decides whether
    // the table may be administered -- and a ruleset that fails to recognise
    // one of these makes the table unusable in whatever stage it forgot,
    // which is precisely the bug this list exists to prevent. Refusals for
    // real reasons are fine; not recognising the intent at all is not.
    for (const [label, state, actor] of stagesToCheck()) {
      const ruleset = getRuleset(state.rulesetId);
      for (const intent of SAMPLES) {
        const verdict = ruleset.validate(state, intent, actor);
        if (verdict.ok) continue;
        expect(verdict.reason, `${label}: ${intent.type}`).not.toMatch(/not part of this game/);
        expect(verdict.reason, `${label}: ${intent.type}`).not.toMatch(/not in play/);
      }
    }
  });

  /** Every stage either ruleset can be sitting in, with somebody to act. */
  function stagesToCheck(): [string, GameState, PlayerId][] {
    const out: [string, GameState, PlayerId][] = [];

    const sevensTable = playing(1, ['ana', 'ben']);
    out.push(['sevens: lobby', playing(1, ['ana', 'ben']).state, 'ana']);
    out.push(['sevens: playing', sevensTable.state, 'ana']);

    let clock = 1_700_000_000_000;
    const seven8 = new Table({
      roomId: '78-stages',
      rulesetId: 'saat-aath',
      rng: makeRng(1),
      now: () => clock++,
      strict: true,
    });
    seven8.create();
    seven8.addPlayer('ana', 'Ana');
    seven8.addPlayer('ben', 'Ben');
    out.push(['7-8: lobby', structuredClone(seven8.state), 'ana']);

    seven8.submit('ana', { type: 'startGame' });
    out.push(['7-8: calling', structuredClone(seven8.state), 'ana']);

    seven8.submit(callerOf(seven8.state)!, { type: 'choose', option: 'S' });
    out.push(['7-8: playing', structuredClone(seven8.state), 'ana']);

    for (let i = 0; i < 2; i++) {
      const actor = seven8.state.turn!;
      seven8.submit(actor, {
        type: 'move',
        cardIds: [saatAath.legalCards!(seven8.state, actor)[0]!],
        toZone: 'trick',
      });
    }
    out.push(['7-8: trick awaiting collection', structuredClone(seven8.state), 'ana']);

    return out;
  }
});
