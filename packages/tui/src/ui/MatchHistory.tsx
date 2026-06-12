import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import type { Match } from '@pokechamps/core/domain/types.js';
import type { Stores, MatchSummary } from '@pokechamps/core/storage/index.js';
import { exportScoutedOpponents } from '@pokechamps/core/domain/scoutExport.js';
import { replayTallyUpTo, approxHpFromTaken } from '@pokechamps/core/domain/replay.js';
import { ExportPanel } from './ExportPanel.js';
import { useTerminalSize } from './useTerminalSize.js';

// Compact HP bar: filled blocks proportional to hp% over `width` cells.
function hpBar(hp: number, width: number): string {
  const filled = Math.round((Math.max(0, Math.min(100, hp)) / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

// One-line field summary from a turn's stored field snapshot (accurate — it's
// persisted per turn). Empty string when nothing notable is up.
function fieldLine(f: Match['field']): string {
  const parts: string[] = [];
  if (f.weather) parts.push(f.weather);
  if (f.terrain) parts.push(`${f.terrain} Terrain`);
  if (f.trickRoom) parts.push('Trick Room');
  if (f.myTailwind) parts.push('Tailwind (you)');
  if (f.theirTailwind) parts.push('Tailwind (opp)');
  return parts.join(' · ');
}

export interface MatchHistoryProps {
  stores: Stores;
  onExit: () => void;
}

function outcomeGlyph(o: Match['outcome']): string {
  if (o === 'victory') return '🏆';
  if (o === 'defeat') return '💀';
  if (o === 'tie') return '🤝';
  return '·';
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return '?';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

export function MatchHistory({ stores, onExit }: MatchHistoryProps) {
  // null = still loading, [] = loaded but empty. The loading state is
  // necessary because the (async) MatchStore.list resolves after first paint.
  const [summaries, setSummaries] = useState<MatchSummary[] | null>(null);
  const [selected, setSelected] = useState<{ id: string; match: Match } | null>(null);
  const [turnCursor, setTurnCursor] = useState(0);
  // Auto-play: when true, a timer advances the turn cursor; stops at the last turn.
  const [playing, setPlaying] = useState(false);
  // When set: render an ExportPanel overlay below the turn display. Esc
  // clears.
  const [exportText, setExportText] = useState<string | null>(null);
  const { columns } = useTerminalSize();
  const narrow = columns < 72;

  useEffect(() => {
    let cancelled = false;
    stores.matches.list().then(list => {
      if (!cancelled) setSummaries(list);
    });
    return () => { cancelled = true; };
  }, [stores]);

  // Replay auto-advance. Steps one turn ~every 1.1s while playing; pauses itself at
  // the final turn. Cancelled on pause, selection change, or unmount.
  useEffect(() => {
    if (!playing || !selected) return;
    const lastTurn = selected.match.turns.length - 1;
    if (turnCursor >= lastTurn) { setPlaying(false); return; }
    const h = setTimeout(() => setTurnCursor(c => Math.min(lastTurn, c + 1)), 1100);
    return () => clearTimeout(h);
  }, [playing, selected, turnCursor]);

  useInput((input, key) => {
    if (key.escape) {
      if (exportText) { setExportText(null); return; }
      if (selected) { setSelected(null); setTurnCursor(0); setPlaying(false); }
      else onExit();
    }
    if (selected && selected.match.turns.length > 0) {
      const last = selected.match.turns.length - 1;
      // Manual stepping always pauses auto-play so the two don't fight.
      if (key.leftArrow) { setPlaying(false); setTurnCursor(c => Math.max(0, c - 1)); }
      if (key.rightArrow) { setPlaying(false); setTurnCursor(c => Math.min(last, c + 1)); }
      if (input === 'g') { setPlaying(false); setTurnCursor(0); }
      if (input === 'G') { setPlaying(false); setTurnCursor(last); }
      // Space = play/pause. Restart from the top if we're already at the end.
      if (input === ' ') setPlaying(p => { if (!p && turnCursor >= last) setTurnCursor(0); return !p; });
    }
    if (selected && input === 'x') {
      setExportText(exportScoutedOpponents(selected.match));
    }
  });

  if (summaries === null) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">Match history</Text>
        <Text dimColor>(loading…)</Text>
        <Text dimColor>[ESC] back</Text>
      </Box>
    );
  }

  if (summaries.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">Match history</Text>
        <Text dimColor>No matches saved yet. Snapshots will appear after `s` in a battle.</Text>
        <Text dimColor>[ESC] back</Text>
      </Box>
    );
  }

  if (selected) {
    const m = selected.match;
    const t = m.turns[turnCursor];
    const hasTurns = m.turns.length > 0;
    const lastTurn = m.turns.length - 1;
    // Board state: turns finalized since 2026-06-12 carry an EXACT post-turn
    // snapshot (t.post); older saves fall back to the approximate cumulative
    // logged-damage tally (heals/EOT not reconstructible — labelled approx).
    const post = hasTurns ? m.turns[turnCursor]?.post : undefined;
    const tally = replayTallyUpTo(m, turnCursor);
    const myHpAt = (i: number) => post ? (post.myHpPercent[i] ?? 100) : approxHpFromTaken(tally.myTaken, i);
    const oppHpAt = (i: number) => post ? (post.oppHpPercent[i] ?? 100) : approxHpFromTaken(tally.oppTaken, i);
    const barW = narrow ? 8 : 14;
    const myIdxs = (m.bring && m.bring.length ? m.bring : m.myTeam.map((_, i) => i)) as number[];
    const oppIdxs = (m.opponentBrought && m.opponentBrought.length ? m.opponentBrought : m.opponentTeam.map((_, i) => i)) as number[];
    const fld = hasTurns ? fieldLine(t!.field) : '';
    const monRow = (name: string, hp: number, dealt: number, key: string) => {
      const col = hp <= 0 ? 'red' : hp <= 33 ? 'yellow' : 'green';
      return (
        <Text key={key}>
          {'  '}{name.slice(0, 14).padEnd(14)} <Text color={col}>{hpBar(hp, barW)}</Text> <Text color={col}>{hp.toFixed(0).padStart(3)}%</Text>
          {hp <= 0 ? <Text color="red"> ✖</Text> : dealt > 0 ? <Text dimColor>  ⚔ {dealt.toFixed(0)}%</Text> : null}
        </Text>
      );
    };
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">
          {outcomeGlyph(m.outcome)} {selected.id} · {fmtDate(m.startedAt)}
        </Text>
        <Text dimColor>
          {playing ? <Text color="green">▶ playing</Text> : <Text color="yellow">❚❚ paused</Text>}
          {' · '}<Text color="white">space</Text> play/pause · ←/→ step · <Text color="white">g</Text>/<Text color="white">G</Text> start/end · <Text color="white">x</Text> export · ESC back
        </Text>
        <Box marginTop={1} flexDirection="column">
          {!hasTurns ? (
            <Text dimColor>(no turns logged)</Text>
          ) : (
            <>
              <Text bold>Turn {t!.index} of {m.turns.length}{turnCursor >= lastTurn ? ' (end)' : ''}{fld ? <Text color="cyan"> · {fld}</Text> : null}</Text>
              <Box marginTop={1} flexDirection="column">
                <Text color="green">You</Text>
                {myIdxs.map(i => monRow(m.myTeam[i]?.species ?? `#${i}`, myHpAt(i), tally.myDealt[i] ?? 0, `my-${i}`))}
                <Box marginTop={1}><Text color="red">Opponent</Text></Box>
                {oppIdxs.map(i => monRow(m.opponentTeam[i]?.species ?? `#${i}`, oppHpAt(i), tally.oppDealt[i] ?? 0, `opp-${i}`))}
                {post
                  ? post.eotNotes?.length
                    ? <Text dimColor>{'  '}EOT: {post.eotNotes.join(', ')}</Text>
                    : null
                  : <Text dimColor>{'  '}(HP approximate — from logged damage; heals/residual not shown)</Text>}
              </Box>
              <Box marginTop={1} flexDirection="column">
                {t!.actions.map((a, i) => (
                  <Text key={i} dimColor>
                    {'  '}{a.order ?? i + 1}. {a.side === 'mine' ? 'm' : 'o'}{a.attackerSlot + 1}
                    {a.mega ? '+mega' : ''}{a.critical ? '+crit' : ''}
                    {' > '}{a.move}
                    {typeof a.target === 'object' ? ` > ${a.target.side === 'mine' ? 'm' : 'o'}${a.target.slot + 1}` : ` > ${a.target}`}
                    {a.damageHpPercent != null ? ` ${a.damageHpPercent.toFixed(0)}% dmg` : ''}
                  </Text>
                ))}
              </Box>
            </>
          )}
        </Box>
        {exportText && (
          <ExportPanel
            title="Scouted opponents export"
            body={exportText}
            hint="Select with your terminal + copy · paste into play.pokemonshowdown.com → Teambuilder · Esc closes"
          />
        )}
      </Box>
    );
  }

  const items = summaries.map(m => ({
    label: `${outcomeGlyph(m.outcome)} ${m.id}  ${fmtDate(m.startedAt)}  ·  ${(m.opponentTeamSpecies ?? []).slice(0, 3).join('/')}…`,
    value: m.id,
  }));

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Match history ({summaries.length})</Text>
      <Text dimColor>↑/↓ pick · Enter view · ESC back</Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          isFocused
          onSelect={item => {
            // Lazy-load the full Match only when the user drills in.
            stores.matches.get(item.value as string).then(m => {
              if (m) { setSelected({ id: m.id, match: m }); setTurnCursor(0); }
            });
          }}
        />
      </Box>
    </Box>
  );
}
