/**
 * Dealing again, by agreement.
 *
 * The asker has seen their cards. Left unchecked, "redeal" is a way to keep
 * dealing until the hand suits you — so it stops being a command and becomes
 * a request that everyone still in the game has to grant.
 */

import { describe, expect, it } from 'vitest';
import { Table, makeRng, type PlayerId } from '../src/index.js';

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
