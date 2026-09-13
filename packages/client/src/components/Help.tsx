/**
 * The two things a newcomer needs: how the app works, and how a game works.
 *
 * Kept apart on purpose. Getting a table going is the same whichever game you
 * pick, so it is said once; the rules differ, so each game says its own. And
 * the rules themselves come from the ruleset rather than from here — a help
 * screen holding its own copy of the rules is a second place for them to go
 * stale.
 */

import { OFFERED_RULESETS, type Ruleset } from '@patte/core';

/**
 * How you work the table.
 *
 * This part *is* the client's to describe: tapping a card, the check button
 * and the sorted hand are not rules of any game, they are how this particular
 * table is operated. The game-specific lines are worked out from what the
 * ruleset already declares — a game that names trump has a `trumpCall`, one
 * where tricks are gathered by hand has an `inlineChoice`, one you can be
 * stuck in has a `passLabel` — so they stay true on their own rather than
 * being a list somebody has to remember to update.
 */
function controlsFor(ruleset: Ruleset): string[] {
  const lines = [
    'Tap a card in your hand to pick it up. A green check appears just above it — tap that to play it.',
    'When your hand is too crowded to aim at, tapping it opens the cards as a strip you can scroll. It opens at the card you touched.',
    'Sort, in the bottom corner, arranges your hand by suit. Tap it again to put the hand back as it was dealt.',
  ];

  if (ruleset.trumpCall) {
    lines.push('When it is your call, a panel asks you to name a trump suit. Everyone else is told what you chose.');
  }
  if (ruleset.inlineChoice) {
    lines.push('A finished trick stays face up in the middle until whoever won it presses Take, so there is time to see what fell.');
  }
  if (ruleset.passLabel) {
    lines.push(`When nothing you are holding can be played, the pill under your hand offers ${ruleset.passLabel}. It only appears when passing really is your only move.`);
  }

  lines.push(
    'The pill under your hand lights up gold when it is your turn, and the cards you may legally play light up with it.',
    'The last card played wears a bright ring, so you can always find what just happened.',
  );
  return lines;
}

/** How to get a game going at all. */
export function HelpPanel({ onClose }: { onClose(): void }): React.JSX.Element {
  const seats = OFFERED_RULESETS.map(
    (ruleset) =>
      `${ruleset.name} — ${
        ruleset.minPlayers === ruleset.maxPlayers
          ? `${ruleset.minPlayers} players`
          : `${ruleset.minPlayers}–${ruleset.maxPlayers} players`
      }`,
  );

  return (
    <div className="panel panel--full" onPointerDown={onClose}>
      <div className="panel__card panel__card--read" onPointerDown={(event) => event.stopPropagation()}>
        <h2>Getting a game going</h2>
        <p>
          पत्ते is a card table you share by link. There is nothing to install and nobody has an
          account — whoever has the code is at the table.
        </p>

        <h3>Start a table</h3>
        <ol className="help__steps">
          <li>Put your name in, so the others know which player is you.</li>
          <li>
            Pick a game. Tap the <strong>?</strong> beside any of them to read how it is played.
          </li>
          <li>Choose how many rounds the match runs to. You can change this later.</li>
          <li>
            Tap <strong>Start a table</strong>. You will get a four-letter code.
          </li>
        </ol>

        <h3>Get the others in</h3>
        <p>
          Tap <strong>Copy link</strong> at the table and send it to them, or read the code out and
          have them type it into <strong>Join</strong> here. Everyone has to be in before the cards
          go out:
        </p>
        <ul className="help__list">
          {seats.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>

        <h3>While you are playing</h3>
        <p>
          <strong>Match</strong> holds the scores and the match length. <strong>Leave</strong>{' '}
          brings you back to this screen, and the code is filled in for you so you can go straight
          back.
        </p>
        <p className="help__note">
          A table lives while people are at it. It does not survive everybody leaving, so play a
          session rather than sending a code out for tomorrow.
        </p>

        <button className="primary" onClick={onClose}>
          Got it
        </button>
      </div>
    </div>
  );
}

/** One game, explained. */
export function RulesPanel({
  ruleset,
  onClose,
}: {
  ruleset: Ruleset;
  onClose(): void;
}): React.JSX.Element {
  const how = ruleset.howToPlay;

  return (
    <div className="panel panel--full" onPointerDown={onClose}>
      <div className="panel__card panel__card--read" onPointerDown={(event) => event.stopPropagation()}>
        <h2>{ruleset.name}</h2>
        <p>{how?.goal ?? ruleset.blurb}</p>

        <h3>
          {ruleset.minPlayers === ruleset.maxPlayers
            ? `${ruleset.minPlayers} players`
            : `${ruleset.minPlayers}–${ruleset.maxPlayers} players`}
        </h3>
        <ul className="help__list">
          {(how?.rules ?? [ruleset.blurb]).map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>

        <h3>At the table</h3>
        <ul className="help__list">
          {controlsFor(ruleset).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>

        <p className="help__note">{ruleset.scoreNote}</p>

        <button className="primary" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
