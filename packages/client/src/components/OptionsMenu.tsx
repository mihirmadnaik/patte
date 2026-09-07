/**
 * Everything that changes the shape of the match rather than playing it:
 * how long it runs, stopping it early, and looking at the scores mid-game.
 *
 * Kept behind a button because none of it is needed on a normal turn, and
 * shown to everyone because seeing the score is not an owner's privilege --
 * only changing the match is.
 */

import { getRuleset, type GameState, type PlayerId } from '@patte/core';
import { useEffect, useRef, useState } from 'react';
import type { Connection } from '../net.js';
import { Scoreboard } from './Scoreboard.js';

export function OptionsMenu({
  state,
  you,
  net,
}: {
  state: GameState;
  you: PlayerId;
  net: Connection;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const ruleset = getRuleset(state.rulesetId);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (ruleset.autoStart) return null; // free play has no match to manage

  const isOwner = state.players[you]?.isOwner ?? false;
  const played = state.match.played.length;

  return (
    <div className="menu" ref={container}>
      <button onClick={() => setOpen(!open)} aria-expanded={open} title="Match options">
        Match ▾
      </button>

      {open && (
        <div className="menu__panel">
          <div className="menu__row">
            <span>
              Round {Math.min(played + (state.phase === 'playing' ? 1 : 0), state.match.rounds)} of{' '}
              {state.match.rounds}
            </span>
          </div>

          {isOwner ? (
            <>
              <div className="menu__row">
                <span>Rounds</span>
                <span className="rounds__stepper">
                  <button
                    disabled={state.match.rounds <= Math.max(played, 1)}
                    onClick={() => net.submit({ type: 'setMatchRounds', rounds: state.match.rounds - 1 })}
                    aria-label="one fewer round"
                  >
                    −
                  </button>
                  <output>{state.match.rounds}</output>
                  <button
                    disabled={state.match.rounds >= 50}
                    onClick={() => net.submit({ type: 'setMatchRounds', rounds: state.match.rounds + 1 })}
                    aria-label="one more round"
                  >
                    +
                  </button>
                </span>
              </div>

              <button
                className="menu__action"
                onClick={() => {
                  net.submit({ type: 'endMatch' });
                  setOpen(false);
                }}
              >
                End the match now
                <em>{state.phase === 'playing' ? 'This round is abandoned, not scored' : 'Stop here'}</em>
              </button>

              <button
                className="menu__action"
                disabled={state.redeal !== null}
                onClick={() => {
                  // Mid-hand this is a redeal with the scores thrown in, so it
                  // goes through the same door: the table has to agree. Between
                  // rounds there is no hand to abandon and nothing to agree to.
                  net.submit(
                    state.phase === 'playing'
                      ? { type: 'proposeRedeal', reset: true }
                      : { type: 'startGame', reset: true },
                  );
                  setOpen(false);
                }}
              >
                Start a new match
                <em>
                  {state.phase === 'playing'
                    ? 'Clears the scores and redeals — everyone has to agree'
                    : 'Clears the scores and redeals'}
                </em>
              </button>
            </>
          ) : (
            <p className="menu__note">The table owner sets the match length.</p>
          )}

          {played > 0 && <Scoreboard state={state} you={you} />}
        </div>
      )}
    </div>
  );
}
