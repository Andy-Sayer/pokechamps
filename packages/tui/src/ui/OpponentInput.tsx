import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { OpponentEntry } from '@pokechamps/core/domain/types.js';
import { searchLegalSpecies, toId } from '@pokechamps/core/domain/data.js';
import type { Stores } from '@pokechamps/core/storage/index.js';

export interface OpponentInputProps {
  stores: Stores;
  onDone: (opp: OpponentEntry[]) => void;
  onCancel: () => void;
}

const SIZE = 6;
const SUGGESTION_LIMIT = 8;

export function OpponentInput({ stores, onDone, onCancel }: OpponentInputProps) {
  const [species, setSpecies] = useState<string[]>(Array(SIZE).fill(''));
  const [activeIdx, setActiveIdx] = useState(0);
  const [value, setValue] = useState('');
  const [highlight, setHighlight] = useState(0);

  const chosenIds = useMemo(() => {
    const s = new Set<string>();
    for (let i = 0; i < species.length; i++) {
      if (i !== activeIdx && species[i]) s.add(toId(species[i]!));
    }
    return s;
  }, [species, activeIdx]);

  const suggestions = useMemo(
    () =>
      searchLegalSpecies(value, SUGGESTION_LIMIT + chosenIds.size)
        .filter(name => !chosenIds.has(toId(name)))
        .slice(0, SUGGESTION_LIMIT),
    [value, chosenIds],
  );

  // Reset highlight whenever the query changes.
  useMemo(() => setHighlight(0), [value]);

  useInput((_input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.upArrow) {
      setHighlight(h => Math.max(0, h - 1));
    } else if (key.downArrow) {
      setHighlight(h => Math.min(suggestions.length - 1, h + 1));
    } else if (key.tab && suggestions[highlight]) {
      // Tab autocompletes the textbox without committing — lets the user
      // refine further if the match isn't right.
      setValue(suggestions[highlight]!);
    }
  });

  const commit = (name: string) => {
    const next = species.slice();
    next[activeIdx] = name;
    setSpecies(next);
    setValue('');
    setHighlight(0);
    // Fire-and-forget background Pikalytics fetch for this species — by the
    // time the user reaches the bring/battle screens, off-meta species often
    // have data ready.
    stores.pikalytics.fetchAndCache(name);
    if (activeIdx < SIZE - 1) {
      setActiveIdx(activeIdx + 1);
    } else if (next.every(s => s.trim())) {
      onDone(next.map(s => ({ species: s, knownMoves: [] })));
    }
  };

  const onSubmit = (v: string) => {
    const picked = suggestions[highlight] ?? v.trim();
    if (!picked) return;
    if (chosenIds.has(toId(picked))) return;
    commit(picked);
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Opponent team — enter the 6 species you see in preview</Text>
      <Text dimColor>Type to filter · ↑/↓ to pick · Tab to autocomplete · Enter to commit · ESC to cancel</Text>

      <Box flexDirection="column" marginTop={1}>
        {species.map((s, i) => (
          <Text key={i} color={i === activeIdx ? 'yellow' : undefined}>
            {i === activeIdx ? '> ' : '  '}{i + 1}. {s || '(empty)'}
          </Text>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text>Species #{activeIdx + 1}: </Text>
        <TextInput value={value} onChange={setValue} onSubmit={onSubmit} />
      </Box>

      <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
        {suggestions.length === 0 ? (
          <Text dimColor>No legal species match "{value}".</Text>
        ) : (
          suggestions.map((name, i) => (
            <Text key={`${i}-${name}`} color={i === highlight ? 'green' : undefined}>
              {i === highlight ? '> ' : '  '}{name}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}
