import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import TextInput from 'ink-text-input';
import type { PokemonSet } from '@pokechamps/core/domain/types.js';
import { parseShowdownTeam, formatShowdownTeam } from '@pokechamps/core/domain/showdown.js';
import type { Stores } from '@pokechamps/core/storage/index.js';

export interface TeamPasteProps {
  stores: Stores;
  onDone: (team: PokemonSet[], name: string) => void;
  onCancel: () => void;
  /** Optional: pre-populate buffer + name with an existing team so the user
   *  can fix a typo and overwrite. Saving with the same name silently
   *  replaces the JSON file on disk. */
  initialTeam?: PokemonSet[];
  initialName?: string;
}

type Phase = 'paste' | 'name' | 'saved';

export function TeamPaste({ stores, onDone, onCancel, initialTeam, initialName }: TeamPasteProps) {
  const [buffer, setBuffer] = useState('');
  const [team, setTeam] = useState<PokemonSet[]>([]);
  const [phase, setPhase] = useState<Phase>('paste');
  const [name, setName] = useState(initialName ?? 'my-team');
  const [error, setError] = useState<string | null>(null);
  // Names already saved on disk — used to flag "(will overwrite)" hints in
  // the name prompt. Loaded once on mount.
  const [existingNames, setExistingNames] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    stores.teams.list().then(rows => {
      if (cancelled) return;
      setExistingNames(new Set(rows.map(r => r.name)));
    });
    return () => { cancelled = true; };
  }, [stores]);

  // Pre-populate the buffer + parsed team when editing an existing team.
  // Round-trip through formatShowdownTeam so the buffer reflects the canonical
  // Showdown form even if the original was hand-typed.
  useEffect(() => {
    if (initialTeam && initialTeam.length) {
      const exported = formatShowdownTeam(initialTeam);
      setBuffer(exported);
      try {
        setTeam(parseShowdownTeam(exported));
      } catch {
        setTeam(initialTeam);
      }
    }
  }, [initialTeam]);

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
    const willOverwrite = existingNames.has(name.trim());
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Team name:</Text>
        <TextInput
          value={name}
          onChange={setName}
          onSubmit={value => {
            const safe = value.trim() || 'my-team';
            // Fire-and-forget: local save should never block the UI; on
            // failure surface to console (no in-screen affordance for it yet).
            void stores.teams.save(safe, team).catch(err => {
              // eslint-disable-next-line no-console
              console.error('saveTeam failed', err);
            });
            setName(safe);
            setPhase('saved');
            onDone(team, safe);
          }}
        />
        {willOverwrite && (
          <Text color="yellow">↻ "{name.trim()}" already exists — saving will overwrite it.</Text>
        )}
      </Box>
    );
  }

  return (
    <Box padding={1}>
      <Text color="green">Saved team "{name}". Returning…</Text>
    </Box>
  );
}
