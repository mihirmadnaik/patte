/**
 * Identifier generation that does not depend on a secure context.
 *
 * `crypto.randomUUID` exists only on HTTPS and localhost. Open the table from
 * a phone on the same Wi-Fi -- `http://192.168.x.x:5173` -- and it is simply
 * undefined, which is one of the main ways this app is meant to be used.
 * `crypto.getRandomValues` carries no such restriction and is the same
 * generator underneath.
 *
 * Deliberately not written as "use randomUUID when available, fall back
 * otherwise": that arrangement runs one path in development and the other on
 * everybody else's device, so the path that matters is the one nobody tests.
 * One path, always taken, covered below.
 */

/** A random version 4 UUID. */
export function randomUuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
