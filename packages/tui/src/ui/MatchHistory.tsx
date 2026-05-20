import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import type { Match } from '@pokechamps/core/domain/types.js';
import { listMatches } from '@pokechamps/core/domain/storage.js';

export interface MatchHistoryProps {
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

export function MatchHistory({ onExit }: MatchHistoryProps) {
  const matches = useMemo(() => listMatches(), []);
  const [selected, setSelected] = useState<{ id: string; match: Match } | null>(null);
  const [turnCursor, setTurnCursor] = useState(0);

  useInput((_input, key) => {
    if (key.escape) {
      if (selected) { setSelected(null); setTurnCursor(0); }
      else onExit();
    }
    if (selected && selected.match.turns.length > 0) {
      if (key.leftArrow) setTurnCursor(c => Math.max(0, c - 1));
      if (key.rightArrow) setTurnCursor(c => Math.min(selected.match.turns.length - 1, c + 1));
    }
  });

  if (matches.length === 0) {
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
      </Box>
    );
  }

  const items = matches.map(m => ({
    label: `${outcomeGlyph(m.match.outcome)} ${m.id}  ${fmtDate(m.match.startedAt)}  ·  ${m.match.opponentTeam.slice(0, 3).map(o => o.species).join('/')}…`,
    value: m.id,
  }));

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Match history ({matches.length})</Text>
      <Text dimColor>↑/↓ pick · Enter view · ESC back</Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          isFocused
          onSelect={item => {
            const m = matches.find(x => x.id === item.value);
            if (m) { setSelected({ id: m.id, match: m.match }); setTurnCursor(0); }
          }}
        />
      </Box>
    </Box>
  );
}
