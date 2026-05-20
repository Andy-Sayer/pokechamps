import React, { useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import TextInput from 'ink-text-input';
import type { PokemonSet } from '@pokechamps/core/domain/types.js';
import { parseShowdownTeam } from '@pokechamps/core/domain/showdown.js';
import { saveTeam } from '@pokechamps/core/domain/storage.js';

export interface TeamPasteProps {
  onDone: (team: PokemonSet[], name: string) => void;
  onCancel: () => void;
}

type Phase = 'paste' | 'name' | 'saved';

export function TeamPaste({ onDone, onCancel }: TeamPasteProps) {
  const [buffer, setBuffer] = useState('');
  const [team, setTeam] = useState<PokemonSet[]>([]);
  const [phase, setPhase] = useState<Phase>('paste');
  const [name, setName] = useState('my-team');
  const [error, setError] = useState<string | null>(null);

  // Re-parse the team whenever the buffer changes.
  const updateBuffer = (next: string) => {
    setBuffer(next);
    try {
      const parsed = parseShowdownTeam(next);
      setTeam(parsed);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  // Some terminals send bracketed-paste sequences (Ink picks these up via usePaste);
  // others (notably Windows Terminal with default settings) send the pasted text as
  // a stream of individual key events, so we also accumulate from useInput below.
  usePaste(text => updateBuffer(buffer + text));

  useInput((input, key) => {
    if (phase !== 'paste') return;
    if (key.escape) return onCancel();
    if (key.ctrl && (input === 's' || input === 'd')) {
      if (team.length) setPhase('name');
      return;
    }
    if (key.ctrl && input === 'x') {
      updateBuffer('');
      return;
    }
    // Treat everything else as text input — pasted content arrives this way
    // when bracketed paste mode is disabled.
    if (key.return) { updateBuffer(buffer + '\n'); return; }
    if (key.tab)    { updateBuffer(buffer + '\t'); return; }
    if (key.backspace || key.delete) {
      updateBuffer(buffer.slice(0, -1));
      return;
    }
    if (input && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
      updateBuffer(buffer + input);
    }
  });

  if (phase === 'paste') {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">Paste a Showdown team export</Text>
        <Text dimColor>Paste the full team text. Ctrl+S when done · Ctrl+X to clear · ESC to cancel.</Text>
        <Box marginTop={1}>
          <Text dimColor>{buffer.length} chars received</Text>
        </Box>
        {team.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="green">Parsed {team.length} pokemon:</Text>
            {team.map((s, i) => (
              <Text key={i}>  {i + 1}. {s.species}{s.item ? ` @ ${s.item}` : ''} — {s.moves.join(', ')}</Text>
            ))}
          </Box>
        )}
        {error && <Text color="red">{error}</Text>}
        {!team.length && buffer && (
          <Text dimColor>No sets parsed yet — make sure the export includes blank lines between mons.</Text>
        )}
      </Box>
    );
  }

  if (phase === 'name') {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Team name:</Text>
        <TextInput
          value={name}
          onChange={setName}
          onSubmit={value => {
            const safe = value.trim() || 'my-team';
            saveTeam(safe, team);
            setName(safe);
            setPhase('saved');
            onDone(team, safe);
          }}
        />
      </Box>
    );
  }

  return (
    <Box padding={1}>
      <Text color="green">Saved team "{name}". Returning…</Text>
    </Box>
  );
}
