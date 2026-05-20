import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { PokemonSet, OpponentEntry } from '@pokechamps/core/domain/types.js';
import { scoreBrings, matchupGrid, type BringScore } from '@pokechamps/core/domain/bring.js';
import { speciesTypes } from '@pokechamps/core/domain/typechart.js';
import { getPikalytics, pikalyticsAvailable } from '@pokechamps/core/domain/pikalytics.js';
import { explainBring } from '@pokechamps/core/ai/prompts.js';
import { isAvailable } from '@pokechamps/core/ai/client.js';

export interface BringPickerProps {
  myTeam: PokemonSet[];
  opponent: OpponentEntry[];
  onConfirm: (indices: [number, number, number, number]) => void;
  onCancel: () => void;
}

function fmtTypes(types: string[]): string {
  return types.length ? types.join('/') : '?';
}

function fmtMult(m: number): string {
  if (m === 0) return ' 0 ';
  if (m >= 4) return '4x ';
  if (m >= 2) return '2x ';
  if (m > 1) return ' ~ ';
  if (m === 1) return ' ~ ';
  if (m >= 0.5) return '.5 ';
  return '.25';
}

function multColor(m: number): string | undefined {
  if (m === 0) return 'gray';
  if (m >= 2) return 'green';
  if (m < 1) return 'red';
  return undefined;
}

function shortName(name: string, width = 8): string {
  return name.length <= width ? name.padEnd(width) : name.slice(0, width);
}

export function BringPicker({ myTeam, opponent, onConfirm, onCancel }: BringPickerProps) {
  const [brings, setBrings] = useState<BringScore[]>([]);
  const [cursor, setCursor] = useState(0);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);

  useEffect(() => {
    setBrings(scoreBrings(myTeam, opponent).slice(0, 5));
    setCursor(0);
  }, [myTeam, opponent]);

  const selected = brings[cursor];
  const grid = useMemo(
    () => selected ? matchupGrid(myTeam, opponent, selected.myIndices) : [],
    [selected, myTeam, opponent],
  );

  useInput((input, key) => {
    if (key.escape) onCancel();
    if (key.upArrow) setCursor(c => Math.max(0, c - 1));
    if (key.downArrow) setCursor(c => Math.min(brings.length - 1, c + 1));
    if (key.return && selected) onConfirm(selected.myIndices);
    if (input === 'e' && brings.length && isAvailable() && !explaining) {
      setExplaining(true);
      explainBring({ myTeam, opponent, topBrings: brings })
        .then(text => setExplanation(text))
        .catch(err => setExplanation(`Error: ${err.message}`))
        .finally(() => setExplaining(false));
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Bring 4 of 6</Text>
      <Text dimColor>↑/↓ to pick · Enter to confirm · e for Claude review · ESC to cancel</Text>

      <Box flexDirection="row" marginTop={1}>
        {/* Left column: teams */}
        <Box flexDirection="column" width={36} marginRight={2}>
          <Text bold>My Team</Text>
          {myTeam.map((m, i) => (
            <Text key={`mt-${i}`}>
              {' '}{i + 1}. {shortName(m.species, 14)} <Text dimColor>[{fmtTypes(speciesTypes(m.species))}]</Text>{m.item ? <Text dimColor> {m.item}</Text> : null}
            </Text>
          ))}
          <Box marginTop={1}><Text bold>Opponent</Text></Box>
          {opponent.map((o, i) => {
            const pik = getPikalytics(o.species);
            const item = pik?.items[0];
            const ability = pik?.abilities[0];
            return (
              <Box key={`op-${i}`} flexDirection="column">
                <Text>
                  {' '}{i + 1}. {shortName(o.species, 14)} <Text dimColor>[{fmtTypes(speciesTypes(o.species))}]</Text>
                </Text>
                {pik && (
                  <Text dimColor>
                    {'    '}
                    {item ? `item: ${item.name} ${item.pct.toFixed(0)}%` : ''}
                    {item && ability ? ' · ' : ''}
                    {ability ? `${ability.name} ${ability.pct.toFixed(0)}%` : ''}
                  </Text>
                )}
              </Box>
            );
          })}
          {!pikalyticsAvailable() && (
            <Text dimColor>(run `npm run refresh-pikalytics` for opp commentary)</Text>
          )}
        </Box>

        {/* Right column: brings + matchup */}
        <Box flexDirection="column" flexGrow={1}>
          <Text bold>Suggested brings (type-matchup weighted)</Text>
          {brings.length === 0 && <Text dimColor>Scoring brings…</Text>}
          {brings.map((b, i) => {
            const mons = b.myIndices.map(idx => myTeam[idx]!.species).join(' + ');
            return (
              <Box key={i} flexDirection="column">
                <Text color={i === cursor ? 'yellow' : undefined}>
                  {i === cursor ? '>' : ' '} {i + 1}. {mons}  <Text dimColor>[total {b.total}]</Text>
                </Text>
                <Text dimColor>     match {b.matchup} · off {b.offense} · def {b.defense} · spd {b.speed} · roles {b.roles}{b.rationale.length ? ` · ${b.rationale.join('; ')}` : ''}</Text>
              </Box>
            );
          })}

          {selected && grid.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Matchup (my STAB+coverage → opp)</Text>
              <Text>
                {'         '}
                {opponent.map((o, j) => (
                  <Text key={`hdr-${j}`} dimColor>{shortName(o.species, 5)} </Text>
                ))}
              </Text>
              {selected.myIndices.map((idx, row) => (
                <Text key={`row-${row}`}>
                  {shortName(myTeam[idx]!.species, 8)} {' '}
                  {grid[row]!.map((m, col) => (
                    <Text key={`c-${row}-${col}`} color={multColor(m)}>{fmtMult(m)}  </Text>
                  ))}
                </Text>
              ))}
            </Box>
          )}
        </Box>
      </Box>

      {explaining && <Box marginTop={1}><Text dimColor>Asking Claude…</Text></Box>}
      {explanation && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="magenta" paddingX={1}>
          <Text bold color="magenta">Claude:</Text>
          <Text>{explanation}</Text>
        </Box>
      )}
      {!isAvailable() && (
        <Text dimColor>Set ANTHROPIC_API_KEY to enable 'e' Claude review.</Text>
      )}
    </Box>
  );
}
