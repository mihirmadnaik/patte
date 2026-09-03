/** Room lifecycle: creation by code, lock sweeping, and reaping the dead. */

import { Room } from './room.js';

/** No vowels and no 0/1/I/O -- codes get read aloud and typed by hand. */
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXYZ23456789';
const CODE_LENGTH = 4;

const LOCK_SWEEP_MS = 2_000;
const REAP_SWEEP_MS = 60_000;
/** How long an empty room keeps its cards where they lie. */
export const ROOM_TTL_MS = 30 * 60_000;
/**
 * How many rooms may exist at once.
 *
 * Rooms are cheap -- a dealt game of Sevens is about 32KB -- but they are free
 * to create and nothing else bounds them, so on a public URL one loop fills
 * the heap in seconds and takes every live game down with it. A ceiling turns
 * that from an outage into a refusal, and 2000 tables is far more than this
 * will ever legitimately hold.
 */
export const MAX_ROOMS = Number(process.env.MAX_ROOMS ?? 2000);

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly timers: ReturnType<typeof setInterval>[] = [];

  start(): void {
    this.timers.push(setInterval(() => this.sweepLocks(), LOCK_SWEEP_MS));
    this.timers.push(setInterval(() => this.reap(), REAP_SWEEP_MS));
    for (const timer of this.timers) timer.unref?.();
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    for (const room of this.rooms.values()) room.dispose();
    this.rooms.clear();
  }

  /** Whether another table would fit. */
  get isFull(): boolean {
    return this.rooms.size >= MAX_ROOMS;
  }

  create(rulesetId?: string, rounds?: number): Room {
    const id = this.freeCode();
    const room = new Room(id, rulesetId, rounds);
    this.rooms.set(id, room);
    return room;
  }

  get(id: string): Room | undefined {
    return this.rooms.get(id.toUpperCase());
  }


  get size(): number {
    return this.rooms.size;
  }

  private freeCode(): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      const code = randomCode();
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('could not find a free room code');
  }

  private sweepLocks(): void {
    for (const room of this.rooms.values()) room.sweepLocks();
  }

  private reap(): void {
    const cutoff = Date.now() - ROOM_TTL_MS;
    for (const [id, room] of this.rooms) {
      if (room.isEmpty && room.lastActivity < cutoff) {
        room.dispose();
        this.rooms.delete(id);
      }
    }
  }
}

export function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let code = '';
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}
