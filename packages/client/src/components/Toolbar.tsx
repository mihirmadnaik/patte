import { getRuleset, type GameState, type PlayerId } from '@patte/core';
import { useState } from 'react';
import { copyText } from '../clipboard.js';
import type { Connection } from '../net.js';
import { useCompact } from '../useCompact.js';
import { OptionsMenu } from './OptionsMenu.js';
import { useEffect, useRef } from 'react';
import { isSoundEnabled, setSoundEnabled, sounds } from '../sound.js';
import { useStore } from '../store.js';

export function Toolbar({
  state,
  you,
  net,
  onLeave,
}: {
  state: GameState;
  you: PlayerId;
  net: Connection;
  onLeave(): void;
}): React.JSX.Element {
  const [dealCount, setDealCount] = useState(5);
  const [sound, setSound] = useState(isSoundEnabled());
  const status = useStore((s) => s.status);
  const selection = useStore((s) => s.selection);
  const toast = useStore((s) => s.toast);
  const isOwner = state.players[you]?.isOwner ?? false;
  const ruleset = getRuleset(state.rulesetId);
  // Shuffling, dealing and sweeping the table are sandbox verbs. In a refereed
  // game the engine would refuse them anyway, and offering a button that
  // cannot work is worse than not offering it.
  const sandbox = ruleset.autoStart;
  // On a phone the sandbox verbs will not fit beside everything else; they
  // fold into a menu instead of wrapping the toolbar onto three rows.
  const compact = useCompact();

  /*
   * Publish how tall this is, so an overlay can start underneath it.
   *
   * The toolbar wraps onto a second row on a narrow screen, so its height is
   * not a constant anyone can hardcode -- and an overlay that guessed low
   * would cover the room code and the way out. Measured after paint and on
   * resize, which is enough: nothing else changes its height.
   */
  const bar = useRef<HTMLElement>(null);
  useEffect(() => {
    const publish = (): void => {
      const height = bar.current?.offsetHeight;
      if (height) document.documentElement.style.setProperty('--toolbar-h', `${height}px`);
    };
    publish();
    window.addEventListener('resize', publish);
    return () => window.removeEventListener('resize', publish);
  });

  const copyLink = async (): Promise<void> => {
    const copied = await copyText(window.location.href);
    toast(
      copied
        ? 'Link copied — send it to whoever you are playing with'
        : `Share this table code: ${state.roomId}`,
    );
  };

  return (
    <header className="toolbar" ref={bar}>
      <div className="toolbar__group">
        <button className="code" onClick={() => void copyLink()} title="Copy the link to this table">
          <em>code</em>
          {state.roomId}
        </button>
        <span className={`status status--${status}`}>
          {status === 'connected' ? 'live' : status === 'reconnecting' ? 'reconnecting…' : status}
        </span>
      </div>

      <div className="toolbar__group">
        <span className="game-name">{ruleset.name}</span>
        {/* "round 2 of 2" is a count towards an end. A game played to a
            ledger has none -- the number would climb with every hand and the
            denominator would climb with it, which says nothing at all. */}
        {!sandbox && !ruleset.openEnded && state.match.rounds > 1 && state.phase !== 'lobby' && (
          <span className="round-count">
            round {Math.min(state.match.played.length + (state.phase === 'playing' ? 1 : 0), state.match.rounds)}
            /{state.match.rounds}
          </span>
        )}
        {!sandbox && ruleset.openEnded && state.match.played.length > 0 && state.phase !== 'lobby' && (
          <span className="round-count">
            hand {state.match.played.length + (state.phase === 'playing' ? 1 : 0)}
          </span>
        )}
      </div>

      {sandbox && !compact && (
      <div className="toolbar__group">
        <button
          onClick={() => {
            net.submit({ type: 'shuffle', zoneId: 'deck' });
            sounds.shuffle();
          }}
        >
          Shuffle
        </button>

        <span className="deal">
          <button
            onClick={() => {
              net.submit({ type: 'deal', fromZone: 'deck', count: dealCount });
              sounds.deal();
            }}
          >
            Deal
          </button>
          <input
            type="number"
            min={1}
            max={13}
            value={dealCount}
            onChange={(event) => setDealCount(Math.max(1, Math.min(13, Number(event.target.value) || 1)))}
            aria-label="cards each"
          />
          <em>each</em>
        </span>

        <button
          onClick={() => {
            net.submit({ type: 'gather', toZone: 'deck' });
            sounds.slide();
          }}
          title="Sweep every card back into the deck, face down"
        >
          Gather
        </button>

        <button
          disabled={selection.length === 0}
          onClick={() => {
            net.submit({ type: 'flip', cardIds: selection });
            sounds.flip();
          }}
        >
          Flip{selection.length > 1 ? ` ${selection.length}` : ''}
        </button>
      </div>
      )}

      <div className="toolbar__group">
        {sandbox && compact && <TableMenu state={state} net={net} />}

        {sandbox && !compact && (
          <button onClick={() => net.submit({ type: 'passTurn' })}>
            {state.turn ? `Turn: ${state.players[state.turn]?.name ?? '—'}` : 'Start turns'}
          </button>
        )}

        {!sandbox && state.phase === 'playing' && isOwner && (
          <button
            disabled={state.redeal !== null}
            onClick={() => net.submit({ type: 'proposeRedeal' })}
            title="Ask the table to abandon this hand and deal again"
          >
            {state.redeal ? 'Asking…' : 'Redeal'}
          </button>
        )}

        <OptionsMenu state={state} you={you} net={net} />

        {sandbox && !compact && isOwner && (
          <label className="toggle" title="Only the player whose turn it is may touch shared cards">
            <input
              type="checkbox"
              checked={state.options.enforceTurnOrder}
              onChange={(event) =>
                net.submit({ type: 'setOption', key: 'enforceTurnOrder', value: event.target.checked })
              }
            />
            enforce turns
          </label>
        )}

        {sandbox && !compact && isOwner && (
          <label className="toggle" title="Turn this off to teach a game with everyone's hand visible">
            <input
              type="checkbox"
              checked={state.options.handsArePrivate}
              onChange={(event) =>
                net.submit({ type: 'setOption', key: 'handsArePrivate', value: event.target.checked })
              }
            />
            private hands
          </label>
        )}

        <LeaveButton midGame={state.phase === 'playing'} onLeave={onLeave} />

        <button
          className="icon"
          title={sound ? 'Mute' : 'Unmute'}
          onClick={() => {
            const next = !sound;
            setSound(next);
            setSoundEnabled(next);
            if (next) sounds.flip();
          }}
        >
          {sound ? '🔊' : '🔇'}
        </button>
      </div>
    </header>
  );
}

/**
 * The way out.
 *
 * Deliberately its own button rather than an item in a menu: the two menus are
 * mode-specific -- match options in a refereed game, sandbox verbs in free
 * play, and neither on a roomy sandbox screen -- and the way out of a room
 * cannot be somewhere you only find in one of the games.
 *
 * Mid-game it asks twice. Leaving costs nothing that cannot be recovered, but
 * a stray thumb on a phone should not drop you out of a hand you were in the
 * middle of, and a button that changes into its own confirmation needs no
 * dialog to say so.
 */
function LeaveButton({ midGame, onLeave }: { midGame: boolean; onLeave(): void }): React.JSX.Element {
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    if (!asked) return;
    const timer = setTimeout(() => setAsked(false), 4000);
    return () => clearTimeout(timer);
  }, [asked]);

  return (
    <button
      className={asked ? 'leave is-asking' : 'leave'}
      title="Go back to the home screen — your seat and hand are kept"
      onClick={() => {
        if (midGame && !asked) {
          setAsked(true);
          return;
        }
        onLeave();
      }}
    >
      {asked ? 'Leave?' : 'Leave'}
    </button>
  );
}

/**
 * The sandbox verbs, folded into a menu.
 *
 * Free play has no match to manage, so it has no menu of its own -- but on a
 * phone its buttons are exactly what will not fit. They move in here rather
 * than wrapping the toolbar onto three rows and taking a sixth of the screen.
 */
function TableMenu({ state, net }: { state: GameState; net: Connection }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const act = (run: () => void) => () => {
    run();
    setOpen(false);
  };

  return (
    <div className="menu" ref={container}>
      <button onClick={() => setOpen(!open)} aria-expanded={open} title="Table actions">
        Table ▾
      </button>
      {open && (
        <div className="menu__panel">
          <button className="menu__action" onClick={act(() => { net.submit({ type: 'shuffle', zoneId: 'deck' }); sounds.shuffle(); })}>
            Shuffle
          </button>
          <button className="menu__action" onClick={act(() => { net.submit({ type: 'deal', fromZone: 'deck', count: 5 }); sounds.deal(); })}>
            Deal 5 each
          </button>
          <button className="menu__action" onClick={act(() => { net.submit({ type: 'gather', toZone: 'deck' }); sounds.slide(); })}>
            Gather
            <em>Sweep every card back into the deck</em>
          </button>
          <button className="menu__action" onClick={act(() => net.submit({ type: 'passTurn' }))}>
            {state.turn ? `Pass the turn on` : 'Start turns'}
          </button>
        </div>
      )}
    </div>
  );
}
