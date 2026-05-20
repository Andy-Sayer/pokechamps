import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { OpponentEntry } from '@pokechamps/core/domain/types.js';
import { speciesTypes } from '@pokechamps/core/domain/typechart.js';
import { getPikalytics } from '@pokechamps/core/domain/pikalytics.js';

export interface OpponentLeadPickerProps {
  opponent: OpponentEntry[];
  onConfirm: (indices: [number, number]) => void;
  onCancel: () => void;
}

const LEAD_SIZE = 2;

// In VGC team preview the opponent commits to 4 brings but you only see
// the 2 leads up front; the back two reveal themselves via switches or
// forced send-ins after a faint. This picker captures just the leads —
// the BattleScreen grows the "brought" set as more opp mons appear on field.
export function OpponentLeadPicker({ opponent, onConfirm, onCancel }: OpponentLeadPickerProps) {
  const [cursor, setCursor] = useState(0);
  const [chosen, setChosen] = useState<Set<number>>(new Set());

  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.upArrow) setCursor(c => Math.max(0, c - 1));
    if (key.downArrow) setCursor(c => Math.min(opponent.length - 1, c + 1));
    if (input === ' ') {
      const next = new Set(chosen);
      if (next.has(cursor)) next.delete(cursor);
      else if (next.size < LEAD_SIZE) next.add(cursor);
      setChosen(next);
    }
    if (key.return && chosen.size === LEAD_SIZE) {
      const ids = [...chosen].sort((a, b) => a - b) as [number, number];
      onConfirm(ids);
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Opponent's leads — which 2 did they send out at preview?</Text>
      <Text dimColor>↑/↓ to move · space to toggle · Enter when 2 selected · ESC to cancel</Text>
      <Text dimColor>The other 2 of their bring will reveal as they switch in or come in on a faint.</Text>
      <Box flexDirection="column" marginTop={1}>
        {opponent.map((o, i) => {
          const pik = getPikalytics(o.species);
          const item = pik?.items[0];
          const ability = pik?.abilities[0];
          const selected = chosen.has(i);
          return (
            <Box key={i} flexDirection="column">
              <Text color={i === cursor ? 'yellow' : undefined}>
                {i === cursor ? '>' : ' '} [{selected ? 'x' : ' '}] {i + 1}. {o.species} <Text dimColor>[{speciesTypes(o.species).join('/') || '?'}]</Text>
              </Text>
              {pik && (
                <Text dimColor>
                  {'      '}
                  {item ? `item: ${item.name} ${item.pct.toFixed(0)}%` : ''}
                  {item && ability ? ' · ' : ''}
                  {ability ? `${ability.name} ${ability.pct.toFixed(0)}%` : ''}
                </Text>
              )}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Selected {chosen.size}/{LEAD_SIZE}
          {chosen.size === LEAD_SIZE ? ' — press Enter to confirm' : ''}
        </Text>
      </Box>
    </Box>
  );
}
