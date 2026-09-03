/**
 * Other players' pointers on the shared surface.
 *
 * The cheapest presence there is, and the most effective: a cursor hovering
 * over the deck is how you know someone is about to deal, the same way a hand
 * reaching across a table tells you.
 */

import type { GameState } from '@patte/core';
import { useStore } from '../store.js';

export function Cursors({
  state,
  bounds,
  originOf,
}: {
  state: GameState;
  bounds: { width: number; height: number };
  /** Where this client draws a given zone. */
  originOf(zoneId: string): { x: number; y: number };
}): React.JSX.Element {
  const cursors = useStore((s) => s.cursors);

  return (
    <>
      {cursors.map((cursor) => {
        // Re-anchor against our own layout: a pointer over their hand belongs
        // over their bundle here, not over ours.
        const anchored =
          cursor.zone && state.zones[cursor.zone] && cursor.dx !== undefined && cursor.dy !== undefined
            ? {
                x: originOf(cursor.zone).x + cursor.dx * bounds.width,
                y: originOf(cursor.zone).y + cursor.dy * bounds.height,
              }
            : { x: cursor.x * bounds.width, y: cursor.y * bounds.height };

        return (
        <div
          key={cursor.playerId}
          className="cursor"
          style={{ transform: `translate3d(${anchored.x}px, ${anchored.y}px, 0)` }}
        >
          <svg viewBox="0 0 12 16" width="12" height="16" aria-hidden="true">
            <path d="M0 0 L0 13 L3.5 9.8 L6 15.5 L8 14.6 L5.6 9 L10.5 9 Z" />
          </svg>
          <span>{state.players[cursor.playerId]?.name ?? 'player'}</span>
        </div>
        );
      })}
    </>
  );
}
