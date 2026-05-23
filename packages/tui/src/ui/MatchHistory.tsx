import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import type { Match } from '@pokechamps/core/domain/types.js';
import type { Stores, MatchSummary } from '@pokechamps/core/storage/index.js';
import { exportScoutedOpponents } from '@pokechamps/core/domain/scoutExport.js';
import { ExportPanel } from './ExportPanel.js';

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
  // When set: render an ExportPanel overlay below the turn display. Esc
  // clears.
  const [exportText, setExportText] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    stores.matches.list().then(list => {
      if (!cancelled) setSummaries(list);
    });
    return () => { cancelled = true; };
  }, [stores]);

  useInput((input, key) => {
    if (key.escape) {
      if (exportText) { setExportText(null); return; }
      if (selected) { setSelected(null); setTurnCursor(0); }
      else onExit();
    }
    if (selected && selected.match.turns.length > 0) {
      if (key.leftArrow) setTurnCursor(c => Math.max(0, c - 1));
      if (key.rightArrow) setTurnCursor(c => Math.min(selected.match.turns.length - 1, c + 1));
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
    const t = selected.match.turns[turnCursor];
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">
          {outcomeGlyph(selected.match.outcome)} {selected.id} · {fmtDate(selected.match.startedAt)}
        </Text>
        <Text dimColor>
          My team: {selected.match.myTeam.map(m => m.species).join(', ')}
        </Text>
        <Text dimColor>
          Opp:     {selected.match.opponentTeam.map(o => o.species).join(', ')}
        </Text>
        <Text dimColor>
          ←/→ step turn · <Text color="white">x</Text> show scouted-opp export · ESC back
        </Text>
        <Box marginTop={1} flexDirection="column">
          {selected.match.turns.length === 0 ? (
            <Text dimColor>(no turns logged)</Text>
          ) : (
            <>
              <Text bold>Turn {t!.index} of {selected.match.turns.length} · ←/→ to step · ESC back</Text>
              {t!.actions.map((a, i) => (
                <Text key={i} dimColor>
                  {'  '}{a.order ?? i + 1}. {a.side === 'mine' ? 'm' : 'o'}{a.attackerSlot + 1}
                  {a.mega ? '+mega' : ''}{a.critical ? '+crit' : ''}
                  {' > '}{a.move}
                  {typeof a.target === 'object' ? ` > ${a.target.side === 'mine' ? 'm' : 'o'}${a.target.slot + 1}` : ` > ${a.target}`}
                  {a.damageHpPercent != null ? ` ${a.damageHpPercent.toFixed(0)}% dmg` : ''}
                </Text>
              ))}
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
