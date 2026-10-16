import { OFFERED_RULESETS, type Ruleset } from '@patte/core';
import { useState } from 'react';
import { HelpPanel, RulesPanel } from './Help.js';

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
  /** Which explanation is open: the app's, one game's, or none. */
  const [reading, setReading] = useState<'help' | Ruleset | null>(null);

  // Only games with a scoreboard have anything to say about match length --
  // and a game scored as a running ledger has no last round to run to, while
  // one whose hand shrinks to a single card has a last round already decided.
  const chosen = OFFERED_RULESETS.find((ruleset) => ruleset.id === rulesetId);
  const multiRound =
    chosen !== undefined && !chosen.autoStart && !chosen.openEnded && !chosen.fixedLength;

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
        <div className="lobby__head">
          <h1>पत्ते</h1>
          <button className="lobby__help" onClick={() => setReading('help')}>
            Help
          </button>
        </div>
        <p>A deck, a table, and whoever you send the link to.</p>

        <label>
          Your name
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Player" maxLength={24} />
        </label>

        <fieldset className="games">
          <legend>Game</legend>
          {OFFERED_RULESETS.map((ruleset) => (
            // The question mark sits beside the label rather than inside it:
            // a button within a label is still a click on the label, so it
            // would pick the game as well as explain it.
            <div key={ruleset.id} className="games__row">
              <label className={rulesetId === ruleset.id ? 'is-chosen' : ''}>
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
              <button
                type="button"
                className="games__rules"
                title={`How to play ${ruleset.name}`}
                aria-label={`How to play ${ruleset.name}`}
                onClick={() => setReading(ruleset)}
              >
                ?
              </button>
            </div>
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

      {reading === 'help' && <HelpPanel onClose={() => setReading(null)} />}
      {reading !== null && reading !== 'help' && (
        <RulesPanel ruleset={reading} onClose={() => setReading(null)} />
      )}
    </div>
  );
}
