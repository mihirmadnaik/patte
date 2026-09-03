/**
 * The match so far: one row per round, one column per player, running totals
 * along the bottom.
 *
 * Lower is better in Sevens -- you score what you were caught holding -- so
 * the leader is the smallest number, which is worth saying out loud rather
 * than leaving people to infer.
 */

import { getRuleset, type GameState, type PlayerId } from '@patte/core';

export function Scoreboard({ state, you }: { state: GameState; you: PlayerId }): React.JSX.Element | null {
  const rounds = state.match.played;
  if (rounds.length === 0) return null;

  // Everyone who has appeared in the match, not just whoever is seated now:
  // a player who left mid-match still has points on the board.
  const players = [...new Set([...state.seatOrder, ...rounds.flatMap((r) => Object.keys(r.scores))])];

  const totalFor = (playerId: PlayerId): number =>
    rounds.reduce((sum, round) => sum + (round.scores[playerId] ?? 0), 0);

  // Which way the numbers read is the ruleset's business: Sevens scores what
  // you were caught holding, 7-8 scores how far past your quota you got.
  const ruleset = getRuleset(state.rulesetId);
  const totals = players.map(totalFor);
  const best = ruleset.scoreDirection === 'high' ? Math.max(...totals) : Math.min(...totals);
  const name = (id: PlayerId): string => (id === you ? 'You' : (state.players[id]?.name ?? 'Player'));

  return (
    <div className="scoreboard">
      <table>
        <thead>
          <tr>
            <th scope="col">Round</th>
            {players.map((id) => (
              <th key={id} scope="col" className={id === you ? 'is-you' : ''}>
                {name(id)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rounds.map((round, index) => (
            <tr key={index}>
              <th scope="row">{index + 1}</th>
              {players.map((id) => (
                <td key={id} className={round.rankings[0] === id ? 'is-winner' : ''}>
                  {round.scores[id] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            {players.map((id) => (
              <td key={id} className={totalFor(id) === best ? 'is-leading' : ''}>
                {totalFor(id)}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
      <p className="scoreboard__note">{ruleset.scoreNote}</p>
    </div>
  );
}
