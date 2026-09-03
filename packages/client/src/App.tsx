import { useCallback, useEffect, useMemo, useState } from 'react';
import { GamePanel, StatusBar, TrumpStrip } from './components/GamePanel.js';
import { Lobby } from './components/Lobby.js';
import { TableView } from './components/TableView.js';
import { Toasts } from './components/Toasts.js';
import { Toolbar } from './components/Toolbar.js';
import { Connection } from './net.js';
import { useStore } from './store.js';

/** The room code lives in the URL, so the link is the invitation. */
function roomFromUrl(): string | null {
  const code = new URLSearchParams(window.location.search).get('t');
  return code ? code.toUpperCase() : null;
}

export function App(): React.JSX.Element {
  const [room, setRoom] = useState(roomFromUrl);
  const [name, setName] = useState(() => localStorage.getItem('patte:name') ?? 'Player');
  const [rulesetId, setRulesetId] = useState<string | undefined>(undefined);
  /**
   * The table just left, offered back on the lobby.
   *
   * Leaving drops the code from the URL, which is the whole point -- but it
   * also throws away the only copy of it most people have. Someone who meant
   * to press something else would otherwise have to remember four characters
   * they never read.
   */
  const [lastRoom, setLastRoom] = useState<string | null>(null);

  const view = useStore((s) => s.view);
  const you = useStore((s) => s.you);
  const status = useStore((s) => s.status);
  const statusMessage = useStore((s) => s.statusMessage);

  const net = useMemo(
    () => (room ? new Connection(room, name, rulesetId) : null),
    [room, name, rulesetId],
  );

  useEffect(() => {
    if (!net) return;
    net.connect();
    return () => net.disconnect();
  }, [net]);

  const enter = (roomId: string, playerName: string, game: string): void => {
    const url = new URL(window.location.href);
    url.searchParams.set('t', roomId);
    // A real history entry, not a replacement. Sitting down at a table is a
    // place you can go back from; overwriting the entry meant Back skipped
    // past the lobby and out of the app altogether.
    window.history.pushState(null, '', url);
    setName(playerName);
    setRulesetId(game);
    setRoom(roomId);
  };

  /**
   * Get up from the table.
   *
   * Nothing is given up by doing this: the server keeps the seat and the hand
   * for a player whose socket closes, exactly as it does for one whose phone
   * goes to sleep, so coming back is a join with the same code. What goes is
   * the connection and this client's copy of the table.
   */
  const leave = useCallback((): void => {
    const url = new URL(window.location.href);
    url.searchParams.delete('t');
    window.history.pushState(null, '', url);
    setLastRoom(room);
    setRoom(null);
    useStore.getState().reset();
  }, [room]);

  // Back and forward now mean what they look like they mean: back out of a
  // table to the lobby, forward into the one you just left.
  useEffect(() => {
    const onPop = (): void => {
      const next = roomFromUrl();
      if (!next && room) setLastRoom(room);
      if (next !== room) useStore.getState().reset();
      setRoom(next);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [room]);

  if (!room || !net) return <Lobby onEnter={enter} lastRoom={lastRoom} />;

  if (!view || !you) {
    return (
      <div className="waiting">
        <p>{status === 'error' ? (statusMessage ?? 'Something went wrong') : 'Pulling up a chair…'}</p>
      </div>
    );
  }

  return (
    <div className="app">
      <Toolbar state={view} you={you} net={net} onLeave={leave} />
      {/* Before the table: on a phone this stops floating and takes a row of
          its own directly under the toolbar. */}
      <TrumpStrip state={view} you={you} />
      <TableView state={view} you={you} net={net} />
      <StatusBar state={view} you={you} net={net} />
      <GamePanel state={view} you={you} net={net} />
      <Toasts />
    </div>
  );
}
