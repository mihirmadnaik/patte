/**
 * Room lifecycle: how many there may be, and what happens to one that is gone.
 *
 * These are the rules that only start to matter when the address is public,
 * which is exactly why they are pinned here rather than left to be discovered
 * by whoever finds the URL first.
 */

import { describe, expect, it } from 'vitest';
import { MAX_ROOMS, RoomManager } from '../src/manager.js';

describe('how many tables there may be', () => {
  it('reports itself full at the ceiling rather than growing without bound', () => {
    const manager = new RoomManager();
    expect(manager.isFull).toBe(false);

    // The ceiling is configurable and high; walk to it rather than assume it.
    for (let i = 0; i < MAX_ROOMS; i++) manager.create('sevens');

    expect(manager.size).toBe(MAX_ROOMS);
    expect(manager.isFull).toBe(true);
    manager.stop();
  });
});

describe('a code with no table behind it', () => {
  it('finds nothing, rather than quietly opening a new table', () => {
    const manager = new RoomManager();
    // The behaviour this replaces was the app's most confusing failure: a
    // typo, a reaped table and a restarted server all silently produced a
    // brand new empty room under the code you asked for, so a game could
    // appear to have been replaced by a sandbox for no visible reason.
    expect(manager.get('NOPE')).toBeUndefined();
    expect(manager.size).toBe(0);
    manager.stop();
  });

  it('finds a real one by code, however it is capitalised', () => {
    const manager = new RoomManager();
    const room = manager.create('sevens');
    expect(manager.get(room.id.toLowerCase())?.id).toBe(room.id);
    manager.stop();
  });
});
