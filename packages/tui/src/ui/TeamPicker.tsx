import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import type { PokemonSet } from '@pokechamps/core/domain/types.js';
import type { Stores, SavedTeam } from '@pokechamps/core/storage/index.js';

export interface TeamPickerProps {
  stores: Stores;
  onPick: (team: PokemonSet[], name: string) => void;
  onCreateNew: () => void;
  onCancel: () => void;
}

export function TeamPicker({ stores, onPick, onCreateNew, onCancel }: TeamPickerProps) {
  // null = still loading. Once loaded, an empty list short-circuits to the
  // create-new flow (preserves the prior synchronous behaviour).
  const [teams, setTeams] = useState<SavedTeam[] | null>(null);
  // ink-select-input fires onHighlight with the focused item — we track that
  // separately to drive the right-hand preview panel.
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    stores.teams.list().then(list => {
      if (cancelled) return;
      setTeams(list);
      setPreview(list[0]?.name ?? null);
      if (list.length === 0) onCreateNew();
    });
    return () => { cancelled = true; };
  }, [stores]);

  if (teams === null) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">Pick your team</Text>
        <Text dimColor>(loading…)</Text>
      </Box>
    );
  }
  if (teams.length === 0) {
    // onCreateNew already invoked from the effect; render nothing while the
    // route transitions.
    return null;
  }

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
