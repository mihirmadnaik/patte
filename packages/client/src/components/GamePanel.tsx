/**
 * Everything the referee needs to say out loud.
 *
 * A rule the player cannot see feels like a bug, so this panel is not
 * decoration: it is where "it is your turn", "you cannot pass because you are
 * holding a playable card", and "here is who won" get stated plainly.
 */

import {
  getRuleset,
  trumpOf,
  type AuctionCall,
  type GameState,
  type PlayerId,
  type StandingsRow,
  type Suit,
} from '@patte/core';
import { useState } from 'react';
import { openingStake, questionOf, stepStake } from '../auction.js';
import { copyText } from '../clipboard.js';
import type { Connection } from '../net.js';
import { seatColour } from '../players.js';
import { sounds } from '../sound.js';
import { useStore } from '../store.js';
import { Scoreboard } from './Scoreboard.js';

/** The code, big enough to read aloud, with the link one tap away. */
function RoomCode({ roomId }: { roomId: string }): React.JSX.Element {
  const toast = useStore((s) => s.toast);
  return (
    <div className="joincode">
      <span className="joincode__label">Table code</span>
      <strong className="joincode__value">{roomId}</strong>
      <button
        onClick={() => {
          void copyText(window.location.href).then((copied) =>
            toast(copied ? 'Link copied — send it to whoever is playing' : `Share this code: ${roomId}`),
          );
        }}
      >
        Copy link
      </button>
    </div>
  );
}

export function GamePanel({
  state,
  you,
  net,
}: {
  state: GameState;
  you: PlayerId;
  net: Connection;
}): React.JSX.Element | null {
  const ruleset = getRuleset(state.rulesetId);
  const [rounds, setRounds] = useState(state.match.rounds);
  // A hand you are entitled to throw in is an offer, not an order: waved away
  // once, it stays away rather than reappearing on every re-render.
  const [waved, setWaved] = useState<string | null>(null);

  // A redeal somebody has asked for outranks everything else on screen: the
  // hand is on hold until it is answered, and the person being waited on is
  // the only one who can move things along.
  if (state.redeal) {
    return <RedealRequest state={state} you={you} net={net} />;
  }

  // A hand the rules say you need not play. Before everything else, because
  // it is about whether this deal should go ahead at all.
  const claim = state.phase === 'playing' ? (ruleset.redealClaim?.(state, you) ?? null) : null;
  if (claim && waved !== claim.prompt) {
    return (
      <div className="panel panel--soft">
        <div className="panel__card">
          <h2>{claim.prompt}</h2>
          <p>
            The cards go back and this hand is dealt again. Nothing is scored, and the deal stays
            where it is.
          </p>
          <div className="panel__actions">
            <button
              className="primary"
              onClick={() => {
                net.submit({ type: 'claimRedeal' });
                sounds.slide();
              }}
            >
              Deal again
            </button>
            <button onClick={() => setWaved(claim.prompt)}>Play it</button>
          </div>
        </div>
      </div>
    );
  }

  // A game can pause mid-deal for a decision: both trick games do, and a third
  // would too. Which game it is, and what it says, is the ruleset's to answer.
  const bidding = ruleset.auction?.(state) ?? null;
  if (bidding) return <Auction state={state} you={you} net={net} call={bidding} />;

  const call = ruleset.trumpCall?.(state) ?? null;
  if (call) return <TrumpCall state={state} you={you} net={net} call={call} />;

  if (ruleset.autoStart && state.phase === 'playing') return null; // free play needs no referee

  const seated = state.seatOrder.length;
  const enough = seated >= ruleset.minPlayers && seated <= ruleset.maxPlayers;
  const isOwner = state.players[you]?.isOwner ?? false;
  const name = (id: PlayerId): string => state.players[id]?.name ?? 'Player';
  const played = state.match.played.length;
  // A game that runs on a ledger has no last round to reach, so nothing is
  // ever over and no scoreboard ever crowns anybody.
  const matchOver = !ruleset.openEnded && played >= state.match.rounds;

  if (state.phase === 'lobby') {
    return (
      <div className="panel">
        <div className="panel__card">
          <h2>{ruleset.name}</h2>
          <p>{ruleset.blurb}</p>

          <RoomCode roomId={state.roomId} />

          <ul className="panel__players">
            {state.seatOrder.map((id) => (
              <li key={id} className={state.players[id]?.connected ? '' : 'is-away'}>
                {name(id)}
                {id === you ? ' (you)' : ''}
              </li>
            ))}
          </ul>

          {isOwner && !ruleset.openEnded && !ruleset.fixedLength && (
            <label className="rounds">
              Rounds to play
              <span className="rounds__stepper">
                <button
                  onClick={() => {
                    const next = Math.max(1, rounds - 1);
                    setRounds(next);
                    net.submit({ type: 'setMatchRounds', rounds: next });
                  }}
                  aria-label="one fewer round"
                >
                  −
                </button>
                <output>{state.match.rounds}</output>
                <button
                  onClick={() => {
                    const next = Math.min(50, rounds + 1);
                    setRounds(next);
                    net.submit({ type: 'setMatchRounds', rounds: next });
                  }}
                  aria-label="one more round"
                >
                  +
                </button>
              </span>
            </label>
          )}

          <button className="primary" disabled={!enough} onClick={() => net.submit({ type: 'startGame' })}>
            Deal
          </button>

          <p className="panel__hint">
            {!enough
              ? `Needs ${ruleset.minPlayers}–${ruleset.maxPlayers} players. ${seated} here — share the code above.`
              : (ruleset.lobbyNote?.(seated) ??
                (ruleset.openEnded
                  ? 'Hands run on until you stop. The score is a ledger, and whoever is carrying it deals.'
                  : `Best of ${state.match.rounds} — the whole deck is dealt out each round.`))}
          </p>
        </div>
      </div>
    );
  }

  if (state.phase === 'finished') {
    const winner = state.rankings[0];
    const standing = ruleset.scoreboard?.(state) ?? [];
    const leader = standing[0];

    return (
      <div className="panel">
        <div className="panel__card panel__card--wide">
          <h2>
            {matchOver
              ? leader
                ? `${leader.playerId === you ? 'You win' : `${name(leader.playerId)} wins`} the match`
                : 'Match over'
              : (ruleset.roundSummary?.(state) ??
                (winner === you ? 'You win the round' : `${name(winner ?? '')} wins the round`))}
          </h2>
          <p>
            {matchOver
              ? `${played} round${played === 1 ? '' : 's'} played.`
              : ruleset.openEnded
                ? `${played} hand${played === 1 ? '' : 's'} played.`
                : `Round ${played} of ${state.match.rounds}.`}
          </p>

          <Scoreboard state={state} you={you} />

          <button
            className="primary"
            onClick={() => net.submit({ type: 'startGame', ...(matchOver ? { reset: true } : {}) })}
          >
            {matchOver ? 'New match' : ruleset.openEnded ? 'Deal the next hand' : `Deal round ${played + 1}`}
          </button>

          {!matchOver && isOwner && (
            <button className="ghost" onClick={() => net.submit({ type: 'endMatch' })}>
              {ruleset.openEnded ? 'Stop here and start over' : 'End the match here'}
            </button>
          )}
        </div>
      </div>
    );
  }

  return null;
}

/**
 * A redeal, put to the table.
 *
 * Everyone sees the same panel; what differs is whether it has buttons. The
 * asker gets a way to withdraw and the names of whoever has not answered, so
 * the wait is never mysterious -- and anyone who has already agreed sees that
 * they have, rather than a question they cannot answer twice.
 */
function RedealRequest({
  state,
  you,
  net,
}: {
  state: GameState;
  you: PlayerId;
  net: Connection;
}): React.JSX.Element | null {
  const proposal = state.redeal;
  if (!proposal) return null;

  const name = (id: PlayerId): string => state.players[id]?.name ?? 'Player';
  const mine = proposal.by === you;
  const yours = proposal.waitingOn.includes(you);
  const waiting = proposal.waitingOn.map(name).join(', ');

  const answer = (agree: boolean) => () => {
    net.submit({ type: 'answerRedeal', agree });
    sounds.slide();
  };

  return (
    <div className="panel">
      <div className="panel__card">
        <h2>{mine ? 'Waiting on the table' : `${name(proposal.by)} wants to redeal`}</h2>
        <p>
          {mine
            ? 'Everyone has to agree before the cards go back in.'
            : proposal.reset
              ? 'This hand would be abandoned and the match started over from nothing.'
              : 'This hand would be abandoned and dealt again. Nothing is scored.'}
        </p>

        {proposal.waitingOn.length > 0 && (
          <p className="panel__note">
            {yours && !mine ? 'It is your call.' : `Still waiting on ${waiting}.`}
          </p>
        )}

        <div className="panel__actions">
          {yours && !mine ? (
            <>
              <button className="primary" onClick={answer(true)}>
                Agree — deal again
              </button>
              <button onClick={answer(false)}>Keep playing</button>
            </>
          ) : mine ? (
            <button onClick={answer(false)}>Never mind</button>
          ) : (
            <p className="panel__note">You have answered. Waiting on {waiting}.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Where the turn status sits.
 *
 * `hand` is a pill centred just beneath your own cards, where you are already
 * looking; the table reserves a band for it so nothing can reach down into it.
 * `corner` tucks the same pill into the bottom-left instead, and `bar` gives
 * it a full-width row of its own.
 *
 * Kept as one switch because this is still being settled; changing the layout
 * should be a word here, not a rewrite.
 */
const PLACEMENT: 'hand' | 'corner' | 'bar' = 'hand';

function shell(mine: boolean): string {
  return `statusbar statusbar--${PLACEMENT}${mine ? ' is-mine' : ''}`;
}

/**
 * The status readout: whose turn it is, and whatever single button is yours
 * to press right now.
 *
 * Tucked in a corner it is easy to overlook, so it states its case loudly
 * when something is actually being asked of you and recedes when it is not.
 */
export function StatusBar({
  state,
  you,
  net,
}: {
  state: GameState;
  you: PlayerId;
  net: Connection;
}): React.JSX.Element | null {
  const ruleset = getRuleset(state.rulesetId);
  if (!ruleset.legalCards || state.phase !== 'playing') return null;

  const name = (id: PlayerId): string => state.players[id]?.name ?? 'Player';
  const inline = ruleset.inlineChoice?.(state, you) ?? null;
  const chooser = ruleset.awaitingChoice?.(state) ?? null;
  // Something the table is asking for that a lit-up hand cannot express on
  // its own -- लॅडीस asking for a card to be set aside, face down, as trump.
  const asked = ruleset.instruction?.(state, you) ?? null;
  // Everyone else's count is on their name plate; yours was the one number on
  // the table you had to work out by counting. In Sevens that matters -- being
  // out of cards is how you win, so how close you are is the score.
  const held = state.zones[`hand:${you}`]?.cards.length ?? 0;
  // Everybody else's colour is on their name plate. You have no plate -- this
  // pill is where your own name would be -- so yours goes here, and without it
  // you would be the one player who could not find their own card in a trick.
  const colour = seatColour(state, you);
  const cards = (
    <span className="statusbar__held">
      {colour && <i className="statusbar__dot" style={{ background: colour }} />}
      {held} card{held === 1 ? '' : 's'}
    </span>
  );

  // A pending decision that is not ours, and not a panel: say who we are
  // waiting on rather than describing a turn that is not happening.
  if (!inline && chooser && chooser !== you) {
    return (
      <div className={shell(false)}>
        <span className="statusbar__text">{asked ?? `Waiting for ${name(chooser)}`}</span>
        {cards}
      </div>
    );
  }

  if (inline) {
    return (
      <div className={shell(true)}>
        {/* Why the button is there is the ruleset's to say: the pill used to
            assert "you won that trick" beside whatever it was handed. */}
        {inline.note && <span className="statusbar__text">{inline.note}</span>}
        {cards}
        <button
          className="statusbar__act"
          onClick={() => {
            net.submit({ type: 'choose', option: inline.option });
            sounds.slide();
          }}
        >
          {inline.label}
        </button>
      </div>
    );
  }

  if (chooser) return null; // a panel is asking for something bigger

  const legal = ruleset.legalCards(state, you);
  const myTurn = state.turn === you;
  const stuck = myTurn && legal.length === 0;
  const pass = ruleset.passLabel;

  /*
   * What the pill says, and what it leaves to be seen.
   *
   * Your turn used to be announced in words and counted in words -- "Your turn
   * -- 5 playable" -- next to a button that could not be pressed. All three
   * were saying something the table was already showing: the pill lights up,
   * the playable cards light up, and a button that cannot be pressed is not an
   * offer. So the words go, and what is left is the count you cannot get any
   * other way.
   *
   * The one exception is being stuck, where there *is* something to do and
   * nothing on the table to suggest it. Then the button appears, and its
   * appearing is the whole message -- it only ever shows when passing is the
   * only move left.
   */
  return (
    <div className={shell(myTurn)}>
      {asked ? (
        <span className="statusbar__text">{asked}</span>
      ) : (
        !myTurn && <span className="statusbar__text">Waiting for {name(state.turn ?? '')}</span>
      )}
      {cards}
      {stuck && pass && (
        <button
          className="statusbar__act"
          title="Nothing you hold can be played — pass the turn on"
          onClick={() => {
            net.submit({ type: 'passTurn' });
            sounds.pickup();
          }}
        >
          {pass}
        </button>
      )}
    </div>
  );
}

/**
 * Whether a standings row speaks for this player.
 *
 * A row is a seat in most games and a side in लॅडीस, so "is this mine?" is
 * not simply an id comparison any more.
 */
function rowCovers(row: StandingsRow, playerId: PlayerId): boolean {
  return row.team ? row.team.includes(playerId) : row.playerId === playerId;
}

/** Who a standings row is, in words, from the reader's point of view. */
function rowNames(state: GameState, row: StandingsRow, you: PlayerId): string {
  const name = (id: PlayerId): string => (id === you ? 'You' : (state.players[id]?.name ?? 'Player'));
  if (!row.team) return name(row.playerId);
  if (row.team.length === 0) return 'Nobody';
  // Your own side reads as "you and whoever", never as your own name.
  const mine = row.team.includes(you);
  const others = row.team.filter((id) => id !== you);
  return mine ? ['You', ...others.map(name)].join(' & ') : row.team.map(name).join(' & ');
}

const SUIT_NAMES: Record<Suit, string> = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };
const SUIT_GLYPHS: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };

/**
 * The pause in the middle of the deal.
 *
 * The non-dealer picks trump on the strength of five cards and nothing else,
 * which is why the ten table cards stay face down until this is answered.
 */
function TrumpCall({
  state,
  you,
  net,
  call,
}: {
  state: GameState;
  you: PlayerId;
  net: Connection;
  call: { chooser: PlayerId; prompt: string };
}): React.JSX.Element {
  const mine = call.chooser === you;
  // What you owe is not this component's to know: the ruleset publishes every
  // quota, and the totals fall out of them.
  const rows = getRuleset(state.rulesetId).standings?.(state) ?? null;
  const mine_ = rows?.find((row) => rowCovers(row, you));
  const tricks = rows?.reduce((total, row) => total + row.quota, 0) ?? 0;

  return (
    <div className="panel panel--soft">
      <div className="panel__card">
        <h2>{mine ? 'Call trump' : 'Waiting for trump'}</h2>
        <p>
          {mine
            ? call.prompt
            : `${state.players[call.chooser]?.name ?? 'Another player'} is choosing a trump suit.`}
        </p>

        {mine && (
          <div className="suits">
            {(['S', 'H', 'D', 'C'] as Suit[]).map((suit) => (
              <button
                key={suit}
                className={`suits__pick${suit === 'H' || suit === 'D' ? ' is-red' : ''}`}
                onClick={() => net.submit({ type: 'choose', option: suit })}
              >
                <span className="suits__glyph">{SUIT_GLYPHS[suit]}</span>
                {SUIT_NAMES[suit]}
              </button>
            ))}
          </div>
        )}

        {mine_ && (
          <p className="panel__hint">
            You must take {mine_.quota} of the {tricks} tricks.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The bidding, as it comes round the table.
 *
 * Like the trump call, everybody sees the same panel and only whoever is
 * speaking gets buttons -- and like it, this knows nothing about the game. The
 * standing call, the word on the button and every stake on offer come from the
 * ruleset; all this does is put a stepper on the numbers and send back a
 * `choose`. Which is why it is a stepper rather than a row of named rungs: how
 * many stakes there are, and what they are worth, is not the client's to know.
 */
function Auction({
  state,
  you,
  net,
  call,
}: {
  state: GameState;
  you: PlayerId;
  net: Connection;
  call: AuctionCall;
}): React.JSX.Element {
  const mine = call.bidder === you;
  const stakes = call.stakes;
  // Kept as the number itself, tied to the question it answers -- never as an
  // index, which means a different number the moment the ladder changes.
  const question = questionOf(call);
  const [picked, setPicked] = useState<{ question: string; stake: number } | null>(null);
  const stake = picked?.question === question ? picked.stake : openingStake(stakes, call.barred);
  const step = (delta: number): void =>
    setPicked((previous) => {
      const from =
        previous?.question === question ? previous.stake : openingStake(stakes, call.barred);
      if (from === undefined) return previous;
      return { question, stake: stepStake(stakes, from, delta) };
    });
  // Allowed by the rules but not to this player, this time. The server
  // refuses it too; this is so the panel can say why before they try.
  const blocked = call.barred !== undefined && stake === call.barred.stake;

  return (
    <div className="panel panel--soft">
      <div className="panel__card">
        <h2>{mine ? 'Your call' : 'Bidding'}</h2>
        <p>
          {mine
            ? call.prompt
            : `${state.players[call.bidder]?.name ?? 'Another player'} is deciding whether to declare.`}
        </p>

        {call.standing && <p className="panel__note">Standing: {call.standing}</p>}

        {mine && (
          <>
            {stake !== undefined && (
              <label className="rounds auction__stake">
                {call.stakeLabel ?? 'Stake'}
                <span className="rounds__stepper">
                  <button onClick={() => step(-1)} aria-label="a smaller stake">
                    −
                  </button>
                  <output>{stake}</output>
                  <button onClick={() => step(1)} aria-label="a larger stake">
                    +
                  </button>
                </span>
              </label>
            )}

            <div className="panel__actions">
              {stake !== undefined && (
                <button
                  className="primary"
                  disabled={blocked}
                  onClick={() => {
                    if (blocked) return;
                    net.submit({ type: 'choose', option: `${call.stakePrefix}${stake}` });
                    sounds.slide();
                  }}
                >
                  {/* Standing on what you already said is a different act
                      from saying a bigger number, and the button says which
                      one it is. */}
                  {call.hold && stake === call.hold.stake
                    ? call.hold.label
                    : `${call.declareLabel} · ${stake}`}
                </button>
              )}
              {/* An auction nobody may sit out offers no way to sit out. In
                  जजमेंट nought is one of the numbers, not a refusal. */}
              {call.passOption !== undefined && (
                <button
                  onClick={() => {
                    net.submit({ type: 'choose', option: call.passOption! });
                    sounds.pickup();
                  }}
                >
                  {call.passLabel}
                </button>
              )}
            </div>
          </>
        )}

        {/* The one rung nobody may stand on explains itself where the player
            is actually looking, rather than only in the prompt above. */}
        {mine && blocked && call.barred && (
          <p className="panel__hint panel__hint--barred">{call.barred.note}</p>
        )}
        {call.hint && <p className="panel__hint">{call.hint}</p>}
      </div>
    </div>
  );
}

/**
 * What is at stake, kept on screen throughout.
 *
 * In 7-8 the two facts that decide everything -- what is trump and how close
 * each player is to their quota -- are otherwise invisible: trump lives in the
 * ruleset's scratchpad and tricks won are just the size of a pile.
 */
export function TrumpStrip({ state, you }: { state: GameState; you: PlayerId }): React.JSX.Element | null {
  const rows = getRuleset(state.rulesetId).standings?.(state) ?? null;
  if (!rows || rows.length === 0) return null;

  // Trump is not named until partway through the deal, so the strip carries
  // the quotas alone until it is. Both facts are otherwise invisible: trump
  // lives in the ruleset's scratchpad and tricks won are just the size of a
  // pile.
  const trump = trumpOf(state);

  return (
    <div className={`trumpstrip${rows.length > 6 ? ' is-crowded' : ''}`}>
      {trump && (
        <span className={`trumpstrip__trump${trump === 'H' || trump === 'D' ? ' is-red' : ''}`}>
          <em>trump</em>
          {SUIT_GLYPHS[trump]}
        </span>
      )}

      {rows.map((row) => (
        <span
          key={row.playerId}
          className={`trumpstrip__player${
            (row.exact ? row.won === row.quota : row.won >= row.quota) ? ' is-met' : ''
          }${
            rowCovers(row, you) ? ' is-yours' : ''
          }`}
        >
          <em>
            {rowNames(state, row, you)}
            {row.note ? ` (${row.note})` : ''}
          </em>
          {row.won}<i>/{row.quota}</i>
        </span>
      ))}
    </div>
  );
}
