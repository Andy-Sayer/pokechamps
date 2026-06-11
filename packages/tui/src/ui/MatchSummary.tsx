// Read-only match recap, rendered inside BattleScreen's outcome box when a
// match ends. The projection logic is the pure, exported summarizeMatch() so
// it's unit-testable; the component is a thin render of that.
import React from 'react';
import { Box, Text } from 'ink';
import type { Match } from '@pokechamps/core/domain/types.js';
import { maxHpFor } from '@pokechamps/core/domain/damage.js';
import { replayTallyUpTo } from '@pokechamps/core/domain/replay.js';

export interface SummaryMon {
  species: string;
  /** Display label: 'fainted' | '<pct>%' | '<raw>'. */
  hp: string;
  fainted: boolean;
  /** Cumulative damage % dealt / taken over the match (logged actions only). */
  dealt: number;
  taken: number;
  /** Direct KOs credited (last-hit actions that zeroed a target). */
  kos: number;
  /** Top damage dealer on my side. */
  mvp?: boolean;
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

// Direct-KO credit per attacker team index: an action whose logged remaining
// HP hit zero. Approximate by design (EOT/hazard deaths have no last-hitter).
function koCredits(match: Match, side: 'mine' | 'theirs'): Record<number, number> {
  const out: Record<number, number> = {};
  for (const turn of match.turns) {
    for (const a of turn.actions) {
      if (a.side !== side || a.kind !== 'move' || a.attackerTeamIndex == null) continue;
      const zeroed = (a.targetRemainingHpPercent != null && a.targetRemainingHpPercent <= 0)
        || (a.targetRemainingHpRaw != null && a.targetRemainingHpRaw <= 0);
      if (zeroed) out[a.attackerTeamIndex] = (out[a.attackerTeamIndex] ?? 0) + 1;
    }
  }
  return out;
}

export function summarizeMatch(match: Match): MatchRecap {
  const brought = match.bring;
  const oppBrought = match.opponentBrought ?? [];
  const date = (() => {
    const d = new Date(match.startedAt);
    return Number.isNaN(d.getTime()) ? match.startedAt : d.toISOString().slice(0, 10);
  })();
  const tally = replayTallyUpTo(match, match.turns.length - 1);
  const myKoBy = koCredits(match, 'mine');
  const oppKoBy = koCredits(match, 'theirs');
  const mine: SummaryMon[] = brought.map(idx => ({
    species: match.myTeam[idx]?.species ?? '?',
    hp: myHpLabel(match, idx),
    fainted: match.myFainted?.includes(idx) ?? false,
    dealt: Math.round(tally.myDealt[idx] ?? 0),
    taken: Math.round(tally.myTaken[idx] ?? 0),
    kos: myKoBy[idx] ?? 0,
  }));
  // MVP: my top damage dealer (KOs break ties), only when someone dealt anything.
  const best = mine.reduce<SummaryMon | null>((b, m) =>
    !b || m.dealt + m.kos * 25 > b.dealt + b.kos * 25 ? m : b, null);
  if (best && best.dealt > 0) best.mvp = true;
  return {
    turns: match.turns.length,
    date,
    myKos: match.opponentTeam.filter(o => o.fainted).length,
    oppKos: (match.myFainted ?? []).filter(i => brought.includes(i as never)).length,
    mine,
    opp: oppBrought.map(idx => ({
      species: match.opponentTeam[idx]?.species ?? '?',
      hp: oppHpLabel(match, idx),
      fainted: match.opponentTeam[idx]?.fainted ?? false,
      dealt: Math.round(tally.oppDealt[idx] ?? 0),
      taken: Math.round(tally.oppTaken[idx] ?? 0),
      kos: oppKoBy[idx] ?? 0,
    })),
  };
}

function cell(m: SummaryMon): string {
  const stats = ` ⚔${m.dealt}% 🛡${m.taken}%${m.kos ? ` KO×${m.kos}` : ''}`;
  return `${m.species.padEnd(13).slice(0, 13)} ${m.hp.padEnd(7)}${stats}`;
}

export function MatchSummary({ match }: { match: Match }) {
  const r = summarizeMatch(match);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{r.turns} turns · {r.date} · KOs: you {r.myKos} · them {r.oppKos} · ⚔ dealt · 🛡 taken (logged %)</Text>
      <Box flexDirection="row" marginTop={1}>
        <Box flexDirection="column" width={42} marginRight={2}>
          <Text bold color="green">You brought</Text>
          {r.mine.map((m, i) => (
            <Text key={`m${i}`} color={m.fainted ? 'gray' : undefined}>{cell(m)}{m.mvp ? ' ⭐MVP' : ''}</Text>
          ))}
        </Box>
        <Box flexDirection="column" width={42}>
          <Text bold color="red">Opponent</Text>
          {r.opp.length === 0
            ? <Text dimColor>(none seen)</Text>
            : r.opp.map((o, i) => (
                <Text key={`o${i}`} color={o.fainted ? 'gray' : undefined}>{cell(o)}</Text>
              ))}
        </Box>
      </Box>
    </Box>
  );
}
