import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import type { PokemonSet, Stats } from '@pokechamps/core/domain/types.js';
import { MAX_IVS } from '@pokechamps/core/domain/types.js';
import {
  searchLegalSpecies, getSpecies, getItem, getNature, getLearnset, loadFormat, toId,
} from '@pokechamps/core/domain/data.js';
import { evFromSp, spFromEv } from '@pokechamps/core/domain/pikalytics.js';
import type { Stores } from '@pokechamps/core/storage/index.js';

export interface TeamBuilderProps {
  stores: Stores;
  onDone: (team: PokemonSet[], name: string) => void;
  onCancel: () => void;
  /** Edit an EXISTING team interactively (roster overview → pick a mon → edit
   *  its fields). Omit for a fresh 6-mon build. */
  initialTeam?: PokemonSet[];
  initialName?: string;
}

const TEAM_SIZE = 6;
const STAT_LABELS: Array<{ key: keyof Stats; label: string }> = [
  { key: 'hp', label: 'HP' },
  { key: 'atk', label: 'Atk' },
  { key: 'def', label: 'Def' },
  { key: 'spa', label: 'SpA' },
  { key: 'spd', label: 'SpD' },
  { key: 'spe', label: 'Spe' },
];
const SP_MAX_PER_STAT = 32;
const SP_TOTAL_MAX = 66;

type Step = 'species' | 'ability' | 'item' | 'nature' | 'spread' | 'move0' | 'move1' | 'move2' | 'move3';

interface Draft {
  species: string;
  ability?: string;
  item?: string;
  nature: string;
  sp: number[];        // length 6, in PoChamps stat-point units (0-32)
  moves: string[];
}

const emptyDraft = (): Draft => ({
  species: '',
  nature: 'Hardy',
  sp: [0, 0, 0, 0, 0, 0],
  moves: [],
});

function draftFromSet(s: PokemonSet): Draft {
  return {
    species: s.species,
    ability: s.ability,
    item: s.item || undefined,
    nature: s.nature || 'Hardy',
    sp: [
      spFromEv(s.evs.hp), spFromEv(s.evs.atk), spFromEv(s.evs.def),
      spFromEv(s.evs.spa), spFromEv(s.evs.spd), spFromEv(s.evs.spe),
    ],
    moves: (s.moves ?? []).slice(0, 4),
  };
}

function draftToPokemonSet(d: Draft): PokemonSet {
  const evs: Stats = {
    hp: evFromSp(d.sp[0]!),
    atk: evFromSp(d.sp[1]!),
    def: evFromSp(d.sp[2]!),
    spa: evFromSp(d.sp[3]!),
    spd: evFromSp(d.sp[4]!),
    spe: evFromSp(d.sp[5]!),
  };
  return {
    species: d.species,
    level: 50,
    item: d.item || undefined,
    ability: d.ability,
    nature: d.nature,
    evs,
    ivs: { ...MAX_IVS },
    moves: d.moves.slice(0, 4),
  };
}

function legalItemNames(): string[] {
  const fmt = loadFormat();
  return fmt.items.allow
    .map(id => (getItem(id) as any)?.name as string | undefined)
    .filter((n): n is string => !!n)
    .sort();
}

function natureItems(): Array<{ label: string; value: string }> {
  const NATURES = [
    'Adamant', 'Bashful', 'Bold', 'Brave', 'Calm', 'Careful', 'Docile', 'Gentle',
    'Hardy', 'Hasty', 'Impish', 'Jolly', 'Lax', 'Lonely', 'Mild', 'Modest',
    'Naive', 'Naughty', 'Quiet', 'Quirky', 'Rash', 'Relaxed', 'Sassy', 'Serious', 'Timid',
  ];
  return NATURES.map(n => {
    const nat = getNature(n) as any;
    const plus = nat?.plus ? `+${nat.plus.toUpperCase()}` : '';
    const minus = nat?.minus ? `-${nat.minus.toUpperCase()}` : '';
    const tag = plus || minus ? ` (${plus}${plus && minus ? '/' : ''}${minus})` : ' (neutral)';
    return { label: `${n}${tag}`, value: n };
  });
}

export function TeamBuilder({ stores, onDone, onCancel, initialTeam, initialName }: TeamBuilderProps) {
  // Edit mode: we were handed an existing team to modify. Start on the roster
  // overview rather than the linear "add 6 mons" flow.
  const editMode = !!(initialTeam && initialTeam.length);
  const [team, setTeam] = useState<PokemonSet[]>(initialTeam ? [...initialTeam] : []);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [step, setStep] = useState<Step>('species');
  const [input, setInput] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [spreadCursor, setSpreadCursor] = useState(0);
  // Tracks consecutive digit keypresses on the spread step so the user can
  // type a multi-digit value (e.g. "3" then "2" → 32). Cleared by any
  // non-digit action (arrow move, +/-, backspace, Enter, field change).
  const [spreadBuffer, setSpreadBuffer] = useState('');
  const [phase, setPhase] = useState<'building' | 'naming' | 'roster'>(editMode ? 'roster' : 'building');
  // When set, committing the in-progress mon REPLACES this roster slot (and
  // returns to the roster) instead of appending.
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [teamName, setTeamName] = useState(initialName ?? 'my-team');
  const [message, setMessage] = useState('');
  // bump on field commit so TextInput remounts with cursor at end
  const [inputKey, setInputKey] = useState(0);

  // ---------------- clause enforcement ----------------
  // Species & item clauses are read from the format file (both true today
  // in Champions Reg M-A). When on, the same species or item can't appear
  // twice across the 6-mon team.
  const fmt = useMemo(loadFormat, []);
  // Exclude the mon currently being edited so its OWN species/item don't read
  // as "already taken" when re-committing unchanged.
  const takenSpeciesIds = useMemo(
    () => fmt.speciesClause ? new Set(team.filter((_, i) => i !== editingIndex).map(m => toId(m.species))) : new Set<string>(),
    [team, fmt.speciesClause, editingIndex],
  );
  const takenItemIds = useMemo(
    () => fmt.itemClause ? new Set(team.filter((_, i) => i !== editingIndex).map(m => m.item).filter(Boolean).map(i => toId(i!))) : new Set<string>(),
    [team, fmt.itemClause, editingIndex],
  );

  // ---------------- per-step suggestion pool ----------------
  const suggestions = useMemo(() => {
    if (step === 'species') {
      // Over-fetch so dedup doesn't shrink the list too much.
      const pool = searchLegalSpecies(input, 8 + takenSpeciesIds.size);
      return pool.filter(n => !takenSpeciesIds.has(toId(n))).slice(0, 8);
    }
    if (step === 'item') {
      const q = input.toLowerCase();
      const pool = legalItemNames().filter(n => !takenItemIds.has(toId(n)));
      if (!q) return pool.slice(0, 8);
      return pool.filter(n => n.toLowerCase().includes(q)).slice(0, 8);
    }
    if (step.startsWith('move')) {
      if (!draft.species) return [];
      const q = input.toLowerCase();
      const moveIdx = parseInt(step.slice(4), 10);
      // Exclude moves in the OTHER slots (no dupes), but keep THIS slot's current
      // move so it shows as the top match and Enter can keep it.
      const taken = new Set(draft.moves.filter((_, i) => i !== moveIdx));
      const learnset = getLearnset(draft.species).filter(m => !taken.has(m));
      if (!q) return learnset.slice(0, 8);
      const prefix: string[] = [];
      const substring: string[] = [];
      for (const n of learnset) {
        const lc = n.toLowerCase();
        const idx = lc.indexOf(q);
        if (idx < 0) continue;
        (idx === 0 ? prefix : substring).push(n);
      }
      return [...prefix, ...substring].slice(0, 8);
    }
    return [];
  }, [step, input, draft.species, draft.moves]);

  // Reset cursors when the active step changes.
  useMemo(() => { setHighlight(0); }, [suggestions.length, step]);

  // Pre-fill the text input with the CURRENT field value when entering a text
  // step, so editing an existing mon shows what's there and "Enter" KEEPS it
  // (type to change). Fresh builds have empty draft fields → empty input, the
  // original behaviour. SelectInput steps (ability/nature) default via
  // `initialIndex` below instead.
  useEffect(() => {
    if (phase !== 'building') return;
    if (step === 'species') setInput(draft.species ?? '');
    else if (step === 'item') setInput(draft.item ?? '');
    else if (step.startsWith('move')) setInput(draft.moves[parseInt(step.slice(4), 10)] ?? '');
    else return;
    setInputKey(k => k + 1);
    // Intentionally keyed on step/phase only: re-prefill on step entry, not on
    // every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, phase]);

  // ---------------- step transitions ----------------
  const commitField = (value: string) => {
    if (step === 'species') {
      const picked = suggestions[highlight] ?? value;
      if (!picked) return;
      if (takenSpeciesIds.has(toId(picked))) {
        setMessage(`Species clause: ${picked} is already on the team.`);
        return;
      }
      setDraft(d => ({ ...d, species: picked }));
      setInput('');
      setMessage('');
      setStep('ability');
    } else if (step === 'item') {
      const picked = suggestions[highlight] ?? value;
      // Empty item is always allowed (no item).
      if (picked && takenItemIds.has(toId(picked))) {
        setMessage(`Item clause: ${picked} is already in use.`);
        return;
      }
      setDraft(d => ({ ...d, item: picked || undefined }));
      setInput('');
      setMessage('');
      setStep('nature');
    } else if (step.startsWith('move')) {
      const moveIdx = parseInt(step.slice(4), 10);
      const picked = suggestions[highlight] ?? value;
      if (!picked) return;
      setDraft(d => {
        const moves = d.moves.slice();
        moves[moveIdx] = picked;
        return { ...d, moves };
      });
      setInput('');
      if (moveIdx >= 3) {
        // Mon complete — append and reset, or move to naming.
        commitMon({ ...draft, moves: [...draft.moves.slice(0, moveIdx), picked] });
      } else {
        setStep(`move${moveIdx + 1}` as Step);
      }
    }
    setInputKey(k => k + 1);
  };

  const commitMon = (final: Draft) => {
    const set = draftToPokemonSet(final);
    // Edit mode: replace the edited slot (or append a new one) and return to the
    // roster overview — never auto-advance to the next mon.
    if (editMode) {
      setTeam(t => editingIndex != null ? t.map((m, i) => (i === editingIndex ? set : m)) : [...t, set]);
      setMessage(editingIndex != null ? `Updated ${final.species}.` : `Added ${final.species}.`);
      setEditingIndex(null);
      setDraft(emptyDraft);
      setSpreadCursor(0);
      setStep('species');
      setPhase('roster');
      return;
    }
    const next = [...team, set];
    setTeam(next);
    setMessage(`Added ${final.species} (${next.length}/${TEAM_SIZE}).`);
    if (next.length >= TEAM_SIZE) {
      setPhase('naming');
      setInput(teamName);
    } else {
      setDraft(emptyDraft);
      setSpreadCursor(0);
      setStep('species');
    }
  };

  // Roster actions (edit mode).
  const startEdit = (idx: number) => {
    setEditingIndex(idx);
    setDraft(draftFromSet(team[idx]!));
    setInput('');
    setMessage('');
    setSpreadCursor(0);
    setStep('species');
    setPhase('building');
    setInputKey(k => k + 1);
  };
  const startAdd = () => {
    setEditingIndex(null);
    setDraft(emptyDraft());
    setInput('');
    setMessage('');
    setSpreadCursor(0);
    setStep('species');
    setPhase('building');
    setInputKey(k => k + 1);
  };
  const goSave = () => { setPhase('naming'); setInput(teamName); setInputKey(k => k + 1); };

  // ---------------- input handling ----------------
  useInput((ch, key) => {
    // Naming + roster phases use their own SelectInput/TextInput — let them run.
    if (phase === 'naming' || phase === 'roster') return;

    // Spread step uses arrows/+/- for direct manipulation, plus digit keys
    // for typing a value directly (e.g. "3" → 3, then "2" → 32).
    if (step === 'spread') {
      const moveCursor = (next: number) => {
        setSpreadCursor(next);
        setSpreadBuffer('');
      };
      if (key.leftArrow) { moveCursor(Math.max(0, spreadCursor - 1)); return; }
      if (key.rightArrow || key.tab) { moveCursor(Math.min(5, spreadCursor + 1)); return; }
      if (key.upArrow || ch === '+' || ch === '=') {
        setSpreadBuffer('');
        setDraft(d => {
          const sp = d.sp.slice();
          const otherTotal = sp.reduce((a, b, i) => i === spreadCursor ? a : a + b, 0);
          const roomTotal = SP_TOTAL_MAX - otherTotal;
          sp[spreadCursor] = Math.min(SP_MAX_PER_STAT, Math.min(roomTotal, sp[spreadCursor]! + 1));
          return { ...d, sp };
        });
        return;
      }
      if (key.downArrow || ch === '-' || ch === '_') {
        setSpreadBuffer('');
        setDraft(d => {
          const sp = d.sp.slice();
          sp[spreadCursor] = Math.max(0, sp[spreadCursor]! - 1);
          return { ...d, sp };
        });
        return;
      }
      if (key.backspace || key.delete) {
        // Drop a digit from the typing buffer; if buffer is empty, zero the field.
        setDraft(d => {
          const sp = d.sp.slice();
          if (spreadBuffer.length > 1) {
            sp[spreadCursor] = parseInt(spreadBuffer.slice(0, -1), 10) || 0;
            setSpreadBuffer(spreadBuffer.slice(0, -1));
          } else {
            sp[spreadCursor] = 0;
            setSpreadBuffer('');
          }
          return { ...d, sp };
        });
        return;
      }
      if (ch && /^[0-9]$/.test(ch)) {
        setDraft(d => {
          const sp = d.sp.slice();
          // Append while buffer < 2 chars (32 is the max), otherwise restart.
          const nextBuf = spreadBuffer.length < 2 ? spreadBuffer + ch : ch;
          let val = parseInt(nextBuf, 10);
          // Clamp to per-stat cap and the remaining total budget.
          const otherTotal = sp.reduce((a, b, i) => i === spreadCursor ? a : a + b, 0);
          val = Math.min(SP_MAX_PER_STAT, val);
          val = Math.min(val, SP_TOTAL_MAX - otherTotal);
          val = Math.max(0, val);
          sp[spreadCursor] = val;
          setSpreadBuffer(nextBuf);
          return { ...d, sp };
        });
        return;
      }
      if (key.return) {
        setSpreadBuffer('');
        setStep('move0');
        return;
      }
      if (key.escape) {
        setSpreadBuffer('');
        setStep('nature');
        return;
      }
      return;
    }

    // Ability/nature steps are SelectInput-driven; only Esc here.
    if (step === 'ability' || step === 'nature') {
      if (key.escape) {
        if (step === 'ability') setStep('species');
        else setStep('item');
      }
      return;
    }

    // Text-input steps (species / item / moves).
    if (key.escape) {
      // Back-step
      const prev: Record<Step, Step> = {
        species: 'species', // can't go further back
        ability: 'species',
        item: 'ability',
        nature: 'item',
        spread: 'nature',
        move0: 'spread',
        move1: 'move0',
        move2: 'move1',
        move3: 'move2',
      };
      if (step === 'species') {
        // Edit mode: bail back to the roster; fresh build: cancel out entirely.
        if (editMode) { setEditingIndex(null); setDraft(emptyDraft()); setPhase('roster'); }
        else onCancel();
        return;
      }
      setStep(prev[step]);
      setInput('');
      setInputKey(k => k + 1);
      return;
    }
    if (suggestions.length > 0) {
      if (key.upArrow) setHighlight(h => Math.max(0, h - 1));
      else if (key.downArrow) setHighlight(h => Math.min(suggestions.length - 1, h + 1));
      else if (key.tab && suggestions[highlight]) {
        setInput(suggestions[highlight]!);
        setInputKey(k => k + 1);
      }
    }
  });

  // ---------------- render ----------------
  const total = draft.sp.reduce((a, b) => a + b, 0);
  const abilityItems = useMemo(() => {
    const sp = getSpecies(draft.species) as any;
    const abs = sp?.abilities ? Object.values(sp.abilities) as string[] : [];
    return abs.filter((a): a is string => !!a).map(a => ({ label: a, value: a }));
  }, [draft.species]);
  const natureSelect = useMemo(natureItems, []);

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">{editMode ? 'Team Editor' : 'Team Builder'}</Text>
      <Text dimColor>Enter commits · Esc backs out a step · Tab autocompletes</Text>

      <Box flexDirection="row" marginTop={1}>
        {/* Left: progress */}
        <Box flexDirection="column" width={28} marginRight={2}>
          <Text bold>Roster ({team.length}/{TEAM_SIZE})</Text>
          {team.map((m, i) => (
            <Text key={i} color="green">  {i + 1}. {m.species}</Text>
          ))}
          {team.length < TEAM_SIZE && (
            <Text color="yellow">  {team.length + 1}. {draft.species || '(in progress)'} ▶ {step}</Text>
          )}
        </Box>

        {/* Right: active step */}
        <Box flexDirection="column" flexGrow={1}>
          {phase === 'roster' ? (
            <StepBlock label="Edit team" hint="↑/↓ pick · Enter · choose a Pokémon to edit, add one, or save">
              <SelectInput
                isFocused
                items={[
                  ...team.map((m, i) => ({ label: `Edit ${i + 1}. ${m.species} — ${m.nature}${m.item ? ` @ ${m.item}` : ''}`, value: `edit:${i}` })),
                  ...(team.length < TEAM_SIZE ? [{ label: '+ Add a Pokémon', value: 'add' }] : []),
                  { label: '✓ Save & exit', value: 'save' },
                ]}
                onSelect={item => {
                  if (item.value === 'add') startAdd();
                  else if (item.value === 'save') goSave();
                  else startEdit(parseInt(item.value.split(':')[1]!, 10));
                }}
              />
            </StepBlock>
          ) : phase === 'naming' ? (
            <Box flexDirection="column">
              <Text bold>Save team as:</Text>
              <Box>
                <Text>{'> '}</Text>
                <TextInput
                  value={input}
                  onChange={setInput}
                  onSubmit={value => {
                    const name = value.trim() || teamName;
                    setTeamName(name);
                    // Fire-and-forget save; UI advances optimistically.
                    void stores.teams.save(name, team).catch(err => {
                      // eslint-disable-next-line no-console
                      console.error('saveTeam failed', err);
                    });
                    onDone(team, name);
                  }}
                />
              </Box>
              <Text dimColor>Enter to save · file: data/my-teams/&lt;name&gt;.json</Text>
            </Box>
          ) : step === 'species' ? (
            <StepBlock label="Species" hint="Type to search the legal pool · ↑/↓ pick · Tab autocomplete · Enter commit">
              <InputLine inputKey={inputKey} value={input} setValue={setInput} onSubmit={commitField} />
              <SuggestionList items={suggestions} highlight={highlight} />
            </StepBlock>
          ) : step === 'ability' ? (
            <StepBlock label={`Ability for ${draft.species}`} hint="↑/↓ pick · Enter commit · Esc back">
              {abilityItems.length === 0 ? (
                <Text dimColor>No abilities for this species (will save as undefined).</Text>
              ) : (
                <SelectInput
                  items={abilityItems}
                  isFocused
                  initialIndex={Math.max(0, abilityItems.findIndex(a => a.value === draft.ability))}
                  onSelect={item => {
                    setDraft(d => ({ ...d, ability: item.value as string }));
                    setStep('item');
                  }}
                />
              )}
            </StepBlock>
          ) : step === 'item' ? (
            <StepBlock label="Item" hint="Type to search legal items · Enter to commit (empty = no item)">
              <InputLine inputKey={inputKey} value={input} setValue={setInput} onSubmit={commitField} />
              <SuggestionList items={suggestions} highlight={highlight} />
            </StepBlock>
          ) : step === 'nature' ? (
            <StepBlock label="Nature" hint="↑/↓ pick · Enter commit · Esc back">
              <SelectInput
                items={natureSelect}
                isFocused
                initialIndex={Math.max(0, natureSelect.findIndex(n => n.value === draft.nature))}
                onSelect={item => {
                  setDraft(d => ({ ...d, nature: item.value as string }));
                  setStep('spread');
                }}
              />
            </StepBlock>
          ) : step === 'spread' ? (
            <StepBlock label={`SP spread (total ${total}/${SP_TOTAL_MAX})`} hint="←/→ or Tab field · type digits to set · ↑/↓ or +/- step · backspace clear · Enter done · Esc back">
              <Box>
                {STAT_LABELS.map((s, i) => (
                  <Box key={s.key} marginRight={1}>
                    <Text dimColor>{s.label} </Text>
                    <Text inverse={i === spreadCursor} color={i === spreadCursor ? 'green' : undefined}>
                      [{String(draft.sp[i]).padStart(2, '0')}]
                    </Text>
                  </Box>
                ))}
              </Box>
              <Text dimColor>Stored as standard EVs (each SP × ~8) for the calc layer.</Text>
            </StepBlock>
          ) : (
            <StepBlock label={`Move ${parseInt(step.slice(4), 10) + 1} of 4`} hint="Enter keeps the shown move · type to change · Tab autocomplete · Esc back">
              <Text dimColor>Picked so far: {draft.moves.filter(Boolean).join(', ') || '(none)'}</Text>
              <InputLine inputKey={inputKey} value={input} setValue={setInput} onSubmit={commitField} />
              <SuggestionList items={suggestions} highlight={highlight} />
            </StepBlock>
          )}
        </Box>
      </Box>

      {message && <Box marginTop={1}><Text color="yellow">{message}</Text></Box>}
    </Box>
  );
}

interface StepBlockProps { label: string; hint: string; children: React.ReactNode }
function StepBlock({ label, hint, children }: StepBlockProps) {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{label}</Text>
      <Text dimColor>{hint}</Text>
      <Box marginTop={1} flexDirection="column">{children}</Box>
    </Box>
  );
}

interface InputLineProps { inputKey: number; value: string; setValue: (v: string) => void; onSubmit: (v: string) => void }
function InputLine({ inputKey, value, setValue, onSubmit }: InputLineProps) {
  return (
    <Box>
      <Text>{'> '}</Text>
      <TextInput key={inputKey} value={value} onChange={setValue} onSubmit={onSubmit} />
    </Box>
  );
}

interface SuggestionListProps { items: string[]; highlight: number }
function SuggestionList({ items, highlight }: SuggestionListProps) {
  if (items.length === 0) return <Text dimColor>(no matches)</Text>;
  return (
    <Box flexDirection="column">
      {items.map((name, i) => (
        <Text key={`${i}-${name}`} inverse={i === highlight} color={i === highlight ? 'green' : undefined}>
          {i === highlight ? ' ▶ ' : '   '}{name}
        </Text>
      ))}
    </Box>
  );
}
