import { OFFERED_RULESETS } from '@patte/core';
import { useState } from 'react';

/** Create a table or join one by code. No accounts, no lobby, no matchmaking. */
export function Lobby({
  onEnter,
  lastRoom,
}: {
  onEnter(roomId: string, name: string, rulesetId: string): void;
  /** The table just left, if any: its code is filled in, ready to go back. */
  lastRoom?: string | null;
}): React.JSX.Element {
  const [name, setName] = useState(() => localStorage.getItem('patte:name') ?? '');
  const [code, setCode] = useState(lastRoom ?? '');
  const [busy, setBusy] = useState(false);
  const [rulesetId, setRulesetId] = useState(OFFERED_RULESETS[0]!.id);
  const [rounds, setRounds] = useState(3);

  // Only games with a scoreboard have anything to say about match length.
  const chosen = OFFERED_RULESETS.find((ruleset) => ruleset.id === rulesetId);
  const multiRound = chosen !== undefined && !chosen.autoStart;

  const remember = (): string => {
    const trimmed = name.trim() || 'Player';
    localStorage.setItem('patte:name', trimmed);
    return trimmed;
  };

  const create = async (): Promise<void> => {
    setBusy(true);
    try {
      const response = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rulesetId, ...(multiRound ? { rounds } : {}) }),
      });
      const { roomId } = (await response.json()) as { roomId: string };
      onEnter(roomId, remember(), rulesetId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lobby">
      <div className="lobby__card">
        <h1>पत्ते</h1>
        <p>A deck, a table, and whoever you send the link to.</p>

        <label>
          Your name
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Player" maxLength={24} />
        </label>

        <fieldset className="games">
          <legend>Game</legend>
          {OFFERED_RULESETS.map((ruleset) => (
            <label key={ruleset.id} className={rulesetId === ruleset.id ? 'is-chosen' : ''}>
              <input
                type="radio"
                name="ruleset"
                value={ruleset.id}
                checked={rulesetId === ruleset.id}
                onChange={() => setRulesetId(ruleset.id)}
              />
              <span className="games__name">{ruleset.name}</span>
              <span className="games__blurb">{ruleset.blurb}</span>
              {ruleset.minPlayers > 1 && (
                <span className="games__count">
                  {ruleset.minPlayers}–{ruleset.maxPlayers} players
                </span>
              )}
            </label>
          ))}
        </fieldset>

        {multiRound && (
          <label className="rounds">
            Rounds to play
            <span className="rounds__stepper">
              <button type="button" onClick={() => setRounds(Math.max(1, rounds - 1))} aria-label="one fewer round">
                −
              </button>
              <output>{rounds}</output>
              <button type="button" onClick={() => setRounds(Math.min(50, rounds + 1))} aria-label="one more round">
                +
              </button>
            </span>
          </label>
        )}

        <button className="primary" disabled={busy} onClick={() => void create()}>
          Start a table
        </button>

        <div className="lobby__or">{lastRoom ? 'or go back' : 'or join one'}</div>

        {lastRoom && (
          <p className="lobby__back">
            You just left <strong>{lastRoom}</strong>. Your seat and your hand are still
            there — join again and you carry on where you were.
          </p>
        )}

        <form
          className="lobby__join"
          onSubmit={(event) => {
            event.preventDefault();
            if (code.trim()) onEnter(code.trim().toUpperCase(), remember(), rulesetId);
          }}
        >
          <input
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="CODE"
            maxLength={6}
            aria-label="table code"
          />
          <button type="submit">Join</button>
        </form>
      </div>
    </div>
  );
}
