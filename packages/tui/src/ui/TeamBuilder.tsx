import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import type { PokemonSet, Stats } from '@pokechamps/core/domain/types.js';
import { MAX_IVS } from '@pokechamps/core/domain/types.js';
import {
  searchLegalSpecies, getSpecies, getItem, getNature, getLearnset, loadFormat, toId,
} from '@pokechamps/core/domain/data.js';
import { saveTeam } from '@pokechamps/core/domain/storage.js';
import { evFromSp } from '@pokechamps/core/domain/pikalytics.js';

export interface TeamBuilderProps {
  onDone: (team: PokemonSet[], name: string) => void;
  onCancel: () => void;
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

export function TeamBuilder({ onDone, onCancel }: TeamBuilderProps) {
  const [team, setTeam] = useState<PokemonSet[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [step, setStep] = useState<Step>('species');
  const [input, setInput] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [spreadCursor, setSpreadCursor] = useState(0);
  // Tracks consecutive digit keypresses on the spread step so the user can
  // type a multi-digit value (e.g. "3" then "2" → 32). Cleared by any
  // non-digit action (arrow move, +/-, backspace, Enter, field change).
  const [spreadBuffer, setSpreadBuffer] = useState('');
  const [phase, setPhase] = useState<'building' | 'naming'>('building');
  const [teamName, setTeamName] = useState('my-team');
  const [message, setMessage] = useState('');
  // bump on field commit so TextInput remounts with cursor at end
  const [inputKey, setInputKey] = useState(0);

  // ---------------- clause enforcement ----------------
  // Species & item clauses are read from the format file (both true today
  // in Champions Reg M-A). When on, the same species or item can't appear
  // twice across the 6-mon team.
  const fmt = useMemo(loadFormat, []);
  const takenSpeciesIds = useMemo(
    () => fmt.speciesClause ? new Set(team.map(m => toId(m.species))) : new Set<string>(),
    [team, fmt.speciesClause],
  );
  const takenItemIds = useMemo(
    () => fmt.itemClause ? new Set(team.map(m => m.item).filter(Boolean).map(i => toId(i!))) : new Set<string>(),
    [team, fmt.itemClause],
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
      const taken = new Set(draft.moves);
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
    const next = [...team, draftToPokemonSet(final)];
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

  // ---------------- input handling ----------------
  useInput((ch, key) => {
    // Naming phase uses its own input — let it run.
    if (phase === 'naming') return;

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
      if (step === 'species') { onCancel(); return; }
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
      <Text bold color="cyan">Team Builder</Text>
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
          {phase === 'naming' ? (
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
                    saveTeam(name, team);
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
            <StepBlock label={`Move ${parseInt(step.slice(4), 10) + 1} of 4`} hint="Type to search learnset · Tab autocomplete · Enter commit · Esc back">
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
