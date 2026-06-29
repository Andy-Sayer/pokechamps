import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import type { OpponentEntry, PokemonSet } from '@pokechamps/core/domain/types.js';
import { speciesTypes } from '@pokechamps/core/domain/typechart.js';
import { defaultOpponentSet } from '@pokechamps/core/domain/bring.js';
import { predictOppBack } from '@pokechamps/core/domain/oppBringPredict.js';
import type { Stores } from '@pokechamps/core/storage/index.js';

export interface OpponentLeadPickerProps {
  stores: Stores;
  opponent: OpponentEntry[];
  /** Our team — used to predict the opponent's BACK TWO once their leads are
   *  chosen (their bring is the 4 best for them vs us; filter to those with both
   *  leads). */
  myTeam: PokemonSet[];
  onConfirm: (indices: [number, number]) => void;
  onCancel: () => void;
  /** Step back one screen (to BringPicker) so the user can change their
   *  bring choice. Triggered by Esc or Left-arrow. If omitted, falls
   *  back to onCancel (which typically routes all the way to the menu). */
  onBack?: () => void;
}

const LEAD_SIZE = 2;

// In VGC team preview the opponent commits to 4 brings but you only see
// the 2 leads up front; the back two reveal themselves via switches or
// forced send-ins after a faint. This picker captures just the leads —
// the BattleScreen grows the "brought" set as more opp mons appear on field.
export function OpponentLeadPicker({ stores, opponent, myTeam, onConfirm, onCancel, onBack }: OpponentLeadPickerProps) {
  const [cursor, setCursor] = useState(0);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  // Resolve the species-only preview entries to default sets so we can score the
  // opponent's brings vs our team (same technique as our own bring decision).
  const oppSets = useMemo(() => opponent.map(e => defaultOpponentSet(e, 50)), [opponent]);

  useInput((input, key) => {
    // Esc + Left-arrow both go back one step (to BringPicker) so the user
    // can fix the bring if they realise they messed it up. When no
    // onBack handler is supplied we fall through to onCancel which
    // typically routes all the way to the main menu.
    if (key.escape || key.leftArrow) { (onBack ?? onCancel)(); return; }
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
      <Text dimColor>↑/↓ to move · space to toggle · Enter when 2 selected · ←/ESC to go back to bring</Text>
      <Text dimColor>The other 2 of their bring will reveal as they switch in or come in on a faint.</Text>
      <Box flexDirection="column" marginTop={1}>
        {opponent.map((o, i) => {
          const pik = stores.pikalytics.get(o.species);
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
      {/* Once both leads are chosen, predict the back two: keep only the brings
          that are best for them vs us AND contain both leads. */}
      {chosen.size === LEAD_SIZE && (() => {
        const leadSp = [...chosen].sort((a, b) => a - b).map(i => opponent[i]!.species);
        const back = predictOppBack(oppSets, myTeam, leadSp, 3);
        return (
          <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="magenta" paddingX={1}>
            <Text><Text color="magenta" bold>⌁ likely back two</Text> <Text dimColor>given {leadSp.join(' + ')}</Text></Text>
            {back.length
              ? back.map((g, i) => <Text key={i}>  {i === 0 ? '→' : ' '} <Text bold={i === 0}>{g.back.map(m => m.species).join(' + ')}</Text></Text>)
              : <Text dimColor>  (no likely bring pairs with both leads)</Text>}
          </Box>
        );
      })()}
      <Box marginTop={1}>
        <Text dimColor>
          Selected {chosen.size}/{LEAD_SIZE}
          {chosen.size === LEAD_SIZE ? ' — press Enter to confirm' : ''}
        </Text>
      </Box>
    </Box>
  );
}
