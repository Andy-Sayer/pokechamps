import React, { useState } from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import type { PokemonSet } from '@pokechamps/core/domain/types.js';
import { listTeams } from '@pokechamps/core/domain/storage.js';

export interface TeamPickerProps {
  onPick: (team: PokemonSet[], name: string) => void;
  onCreateNew: () => void;
  onCancel: () => void;
}

export function TeamPicker({ onPick, onCreateNew, onCancel }: TeamPickerProps) {
  const teams = listTeams();
  if (teams.length === 0) {
    onCreateNew();
    return null;
  }
  // ink-select-input fires onHighlight with the focused item — we track that
  // separately to drive the right-hand preview panel.
  const initialPreview = teams[0]?.name ?? null;
  const [preview, setPreview] = useState<string | null>(initialPreview);

  const items = [
    ...teams.map(t => ({ label: t.name, value: t.name })),
    { label: '+ paste a new team', value: '__new__' },
    { label: 'cancel', value: '__cancel__' },
  ];

  const previewTeam = preview ? teams.find(t => t.name === preview)?.team ?? [] : [];

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Pick your team</Text>
      <Box marginTop={1} flexDirection="row">
        <Box width={30} marginRight={2} flexDirection="column">
          <SelectInput
            items={items}
            onHighlight={item => {
              const v = item.value as string;
              if (v.startsWith('__')) setPreview(null);
              else setPreview(v);
            }}
            onSelect={item => {
              if (item.value === '__new__') onCreateNew();
              else if (item.value === '__cancel__') onCancel();
              else {
                const t = teams.find(t => t.name === item.value)!;
                onPick(t.team, t.name);
              }
            }}
          />
        </Box>
        <Box flexDirection="column" flexGrow={1} borderStyle="round" paddingX={1}>
          {preview ? (
            <>
              <Text bold>{preview}</Text>
              {previewTeam.length === 0 ? (
                <Text dimColor>(empty team)</Text>
              ) : previewTeam.map((m, i) => (
                <Text key={i}>
                  {i + 1}. {m.species}
                  {m.item ? <Text dimColor> @ {m.item}</Text> : null}
                </Text>
              ))}
            </>
          ) : (
            <Text dimColor>Highlight a team to preview its mons.</Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}
