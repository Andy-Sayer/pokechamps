// Read-only match recap, rendered inside BattleScreen's outcome box when a
// match ends. The projection logic is the pure, exported summarizeMatch() so
// it's unit-testable; the component is a thin render of that.
import React from 'react';
import { Box, Text } from 'ink';
import type { Match } from '@pokechamps/core/domain/types.js';
import { maxHpFor } from '@pokechamps/core/domain/damage.js';

export interface SummaryMon {
  species: string;
  /** Display label: 'fainted' | '<pct>%' | '<raw>'. */
  hp: string;
  fainted: boolean;
}

export interface MatchRecap {
  turns: number;
  date: string;
  myKos: number;   // opp mons we knocked out
  oppKos: number;  // my brought mons that fainted
  mine: SummaryMon[];
  opp: SummaryMon[];
}

function pct(n: number): string {
  return `${Math.max(0, Math.round(n))}%`;
}

// My side stores raw current HP; convert to % for a uniform display with the
// opponent (whose HP we only ever know as a %).
function myHpLabel(match: Match, teamIdx: number): string {
  if (match.myFainted?.includes(teamIdx)) return 'fainted';
  const raw = match.myCurrentHp?.[teamIdx];
  if (raw == null) return '100%';
  const set = match.myTeam[teamIdx];
  const max = set ? maxHpFor(set) : 0;
  return max > 0 ? pct((raw / max) * 100) : `${raw}`;
}

function oppHpLabel(match: Match, teamIdx: number): string {
  const o = match.opponentTeam[teamIdx];
  if (!o) return '—';
  if (o.fainted) return 'fainted';
  return o.currentHpPercent != null ? pct(o.currentHpPercent) : '100%';
}

export function summarizeMatch(match: Match): MatchRecap {
  const brought = match.bring;
  const oppBrought = match.opponentBrought ?? [];
  const date = (() => {
    const d = new Date(match.startedAt);
    return Number.isNaN(d.getTime()) ? match.startedAt : d.toISOString().slice(0, 10);
  })();
  return {
    turns: match.turns.length,
    date,
    myKos: match.opponentTeam.filter(o => o.fainted).length,
    oppKos: (match.myFainted ?? []).filter(i => brought.includes(i as never)).length,
    mine: brought.map(idx => ({
      species: match.myTeam[idx]?.species ?? '?',
      hp: myHpLabel(match, idx),
      fainted: match.myFainted?.includes(idx) ?? false,
    })),
    opp: oppBrought.map(idx => ({
      species: match.opponentTeam[idx]?.species ?? '?',
      hp: oppHpLabel(match, idx),
      fainted: match.opponentTeam[idx]?.fainted ?? false,
    })),
  };
}

function cell(species: string, hp: string): string {
  return `${species.padEnd(14).slice(0, 14)} ${hp}`;
}

export function MatchSummary({ match }: { match: Match }) {
  const r = summarizeMatch(match);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{r.turns} turns · {r.date} · KOs: you {r.myKos} · them {r.oppKos}</Text>
      <Box flexDirection="row" marginTop={1}>
        <Box flexDirection="column" width={26} marginRight={2}>
          <Text bold color="green">You brought</Text>
          {r.mine.map((m, i) => (
            <Text key={`m${i}`} color={m.fainted ? 'gray' : undefined}>{cell(m.species, m.hp)}</Text>
          ))}
        </Box>
        <Box flexDirection="column" width={26}>
          <Text bold color="red">Opponent</Text>
          {r.opp.length === 0
            ? <Text dimColor>(none seen)</Text>
            : r.opp.map((o, i) => (
                <Text key={`o${i}`} color={o.fainted ? 'gray' : undefined}>{cell(o.species, o.hp)}</Text>
              ))}
        </Box>
      </Box>
    </Box>
  );
}
