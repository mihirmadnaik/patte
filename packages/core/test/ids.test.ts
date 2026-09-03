import { describe, expect, it } from 'vitest';
import { randomUuid } from '../src/ids.js';

/**
 * These exist because the bug they guard against is invisible in development:
 * `crypto.randomUUID` works on localhost and is undefined over plain HTTP, so
 * a phone on the same Wi-Fi hit a failure no amount of local testing would
 * have shown.
 */
describe('randomUuid', () => {
  const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('produces a well-formed version 4 UUID', () => {
    for (let i = 0; i < 200; i++) expect(randomUuid()).toMatch(V4);
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 5_000 }, randomUuid));
    expect(seen.size).toBe(5_000);
  });

  it('uses only getRandomValues, which needs no secure context', () => {
    // Stand in for a page served over plain HTTP, where randomUUID is absent.
    const original = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: undefined,
    });
    try {
      expect(globalThis.crypto.randomUUID).toBeUndefined();
      expect(randomUuid()).toMatch(V4);
    } finally {
      if (original) Object.defineProperty(globalThis.crypto, 'randomUUID', original);
    }
  });
});
