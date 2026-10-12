/**
 * The match so far: one row per round, one column per player -- or per side --
 * and running totals along the bottom.
 *
 * Lower is better in Sevens -- you score what you were caught holding -- so
 * the leader is the smallest number, which is worth saying out loud rather
 * than leaving people to infer.
 *
 * A game played in partnerships gets a column per side rather than per player.
 * Partners always score the same number in लाडीस, because what is scored is
 * the side's standing, so four columns would be two pairs of identical ones.
 */

import { getRuleset, type GameState, type PlayerId } from '@patte/core';

export function Scoreboard({ state, you }: { state: GameState; you: PlayerId }): React.JSX.Element | null {
  const rounds = state.match.played;
  if (rounds.length === 0) return null;

  // Everyone who has appeared in the match, not just whoever is seated now:
  // a player who left mid-match still has points on the board.
  const seen = [...new Set([...state.seatOrder, ...rounds.flatMap((r) => Object.keys(r.scores))])];
  // A column is a side where there are sides, and a player where there are
  // not. Anybody the sides do not account for keeps a column of their own.
  const sides = state.teams.filter((team) => team.length > 0);
  const grouped = new Set(sides.flat());
  const columns: PlayerId[][] =
    sides.length > 0 ? [...sides, ...seen.filter((id) => !grouped.has(id)).map((id) => [id])] : seen.map((id) => [id]);

  const scoreOf = (column: PlayerId[], round: GameState['match']['played'][number]): number | null => {
    const values = column.map((id) => round.scores[id]).filter((value): value is number => value !== undefined);
    return values.length > 0 ? Math.max(...values) : null;
  };

  const totalFor = (column: PlayerId[]): number =>
    rounds.reduce((sum, round) => sum + (scoreOf(column, round) ?? 0), 0);

  // Which way the numbers read is the ruleset's business: Sevens scores what
  // you were caught holding, 7-8 scores how far past your quota you got.
  const ruleset = getRuleset(state.rulesetId);
  const totals = columns.map(totalFor);
  const best = ruleset.scoreDirection === 'high' ? Math.max(...totals) : Math.min(...totals);
  const name = (id: PlayerId): string => (id === you ? 'You' : (state.players[id]?.name ?? 'Player'));
  const heading = (column: PlayerId[]): string => {
    if (column.length === 1) return name(column[0]!);
    const mine = column.includes(you);
    const others = column.filter((id) => id !== you);
    return mine ? ['You', ...others.map(name)].join(' & ') : column.map(name).join(' & ');
  };
  const key = (column: PlayerId[]): string => column.join('+');
  const mine = (column: PlayerId[]): boolean => column.includes(you);

  return (
    <div className="scoreboard">
      <table>
        <thead>
          <tr>
            <th scope="col">Round</th>
            {columns.map((column) => (
              <th key={key(column)} scope="col" className={mine(column) ? 'is-you' : ''}>
                {heading(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rounds.map((round, index) => (
            <tr key={index}>
              <th scope="row">{index + 1}</th>
              {columns.map((column) => (
                <td
                  key={key(column)}
                  className={column.includes(round.rankings[0] ?? '') ? 'is-winner' : ''}
                >
                  {scoreOf(column, round) ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            {columns.map((column) => (
              <td key={key(column)} className={totalFor(column) === best ? 'is-leading' : ''}>
                {totalFor(column)}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
      <p className="scoreboard__note">{ruleset.scoreNote}</p>
    </div>
  );
}
