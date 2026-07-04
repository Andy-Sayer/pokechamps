import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { PokemonSet, OpponentEntry } from '@pokechamps/core/domain/types.js';
import { scoreBrings, matchupGrid, predictOppLeads, defaultOpponentSet, type BringScore } from '@pokechamps/core/domain/bring.js';
import { bringNash, bringThreats } from '@pokechamps/core/domain/bringRecommend.js';
import { predictOppBring } from '@pokechamps/core/domain/oppBringPredict.js';
import { tacticLabel } from '@pokechamps/core/domain/tactics.js';
import { speciesTypes } from '@pokechamps/core/domain/typechart.js';
import { pikalyticsAvailable } from '@pokechamps/core/domain/pikalytics.js';
import { explainBring } from '@pokechamps/core/ai/prompts.js';
import { isAvailable } from '@pokechamps/core/ai/client.js';
import type { Stores } from '@pokechamps/core/storage/index.js';
import { PikaSpinner } from './PikaSpinner.js';

export interface BringPickerProps {
  stores: Stores;
  myTeam: PokemonSet[];
  opponent: OpponentEntry[];
  teamName: string; // matrix slug — which team's Nash corpus to read
  onConfirm: (indices: [number, number, number, number]) => void;
  onCancel: () => void;
}

function fmtTypes(types: string[]): string {
  return types.length ? types.join('/') : '?';
}
const pctStr = (x: number) => `${Math.round(x * 100)}%`;

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

export function BringPicker({ stores, myTeam, opponent, teamName, onConfirm, onCancel }: BringPickerProps) {
  const [brings, setBrings] = useState<BringScore[]>([]);
  const [cursor, setCursor] = useState(0);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);
  // Custom mode: when on, the suggestion list is ignored and the user
  // builds their own 4-of-6 by toggling team indices with number keys.
  // Esc returns to suggestion mode; the custom pick stays so they can
  // re-enter and fix mistakes.
  //
  // customPicks is an ORDERED array (not a Set) so the user's tap order
  // becomes the bring order — important: the first tap is the lead, the
  // second tap is m2, etc. Sorting would lose that intent.
  const [customMode, setCustomMode] = useState(false);
  const [customPicks, setCustomPicks] = useState<number[]>([]);
  const [customError, setCustomError] = useState<string | null>(null);

  useEffect(() => {
    setBrings(scoreBrings(myTeam, opponent).slice(0, 5));
    setCursor(0);
  }, [myTeam, opponent]);

  // Lead prediction runs full learnset-potential tactic detection — memoized
  // so it doesn't re-run on every keystroke render.
  const oppLead = useMemo(() => predictOppLeads(opponent), [opponent]);
  // Secondary task: what 4 the opponent likely brings vs OUR team (scored with the
  // same technique as our own bring, sides flipped) — so we choose knowing what to
  // expect. Species-only at preview → default sets.
  const oppBringPred = useMemo(
    () => (opponent.length >= 4 ? predictOppBring(opponent.map(e => defaultOpponentSet(e, 50)), myTeam, 2) : null),
    [opponent, myTeam],
  );

  // Effective selection: custom picks (when valid) override the suggestion
  // cursor. Used for the matchup preview and Enter-to-confirm.
  const customIndices = useMemo<[number, number, number, number] | null>(() => {
    if (customPicks.length !== 4) return null;
    return [...customPicks] as [number, number, number, number];
  }, [customPicks]);

  const selected = brings[cursor];
  const effectiveIndices = customMode && customIndices ? customIndices : selected?.myIndices;
  const grid = useMemo(
    () => effectiveIndices ? matchupGrid(myTeam, opponent, effectiveIndices) : [],
    [effectiveIndices, myTeam, opponent],
  );
  const oppSpecies = useMemo(() => opponent.map(o => o.species), [opponent]);
  // Sim-derived Nash bring for the faced 6 (null until a matrix corpus is built for this team).
  const nash = useMemo(() => bringNash(teamName, oppSpecies), [teamName, oppSpecies]);
  // Dossier threat read: which of the currently-selected bring's mons each opp mon hits SE.
  const threats = useMemo(
    () => effectiveIndices ? bringThreats(oppSpecies, effectiveIndices.map(i => myTeam[i]!.species)) : [],
    [oppSpecies, effectiveIndices, myTeam],
  );

  useInput((input, key) => {
    if (key.escape) {
      if (customMode) { setCustomMode(false); setCustomError(null); return; }
      onCancel();
      return;
    }
    if (input === 'c') {
      setCustomMode(m => !m);
      setCustomError(null);
      return;
    }
    if (customMode) {
      // 1-6 toggle inclusion. Enforces a max of 4 — the 5th tap is rejected.
      // Tap order is preserved (becomes bring order).
      const n = parseInt(input, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= myTeam.length) {
        const idx = n - 1;
        setCustomPicks(prev => {
          if (prev.includes(idx)) {
            setCustomError(null);
            return prev.filter(i => i !== idx);
          }
          if (prev.length >= 4) {
            setCustomError('Already 4 picked — tap one to remove it first.');
            return prev;
          }
          setCustomError(null);
          return [...prev, idx];
        });
        return;
      }
      if (key.return) {
        if (customIndices) onConfirm(customIndices);
        else setCustomError(`Pick exactly 4 mons (currently ${customPicks.length}).`);
        return;
      }
      return;
    }
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
      <Text dimColor>
        {customMode
          ? <>Custom mode · 1-6 toggle · Enter confirms · ESC back to suggestions</>
          : <>↑/↓ pick suggestion · Enter confirm · <Text color="white">c</Text> custom · e Claude review · ESC cancel</>}
      </Text>

      <Box flexDirection="row" marginTop={1}>
        {/* Left column: teams */}
        <Box flexDirection="column" width={36} marginRight={2}>
          <Text bold>My Team</Text>
          {myTeam.map((m, i) => {
            const pickPos = customMode ? customPicks.indexOf(i) : -1;
            const picked = pickPos >= 0;
            // Highlight picks in green when in custom mode. The number prefix
            // shown next to each mon (1-6) doubles as the toggle key. The
            // pick-order number (#1/#2/#3/#4) shows which bring slot it'll
            // become — first tap is the lead.
            return (
              <Text key={`mt-${i}`} color={picked ? 'green' : undefined}>
                {customMode ? (picked ? `#${pickPos + 1}` : '  ') : ' '} {i + 1}. {shortName(m.species, 14)} <Text dimColor>[{fmtTypes(speciesTypes(m.species))}]</Text>{m.item ? <Text dimColor> {m.item}</Text> : null}
              </Text>
            );
          })}
          <Box marginTop={1}><Text bold>Opponent</Text></Box>
          {opponent.map((o, i) => {
            const pik = stores.pikalytics.get(o.species);
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
          {customMode ? (
            <Box flexDirection="column">
              <Text bold color="yellow">Custom bring</Text>
              <Text>
                Picked {customPicks.length}/4 <Text dimColor>(in bring order — first tap is lead):</Text>{' '}
                {customPicks.length === 0
                  ? <Text dimColor>(none yet — tap 1-6 to add)</Text>
                  : customPicks.map(i => myTeam[i]!.species).join(' → ')}
              </Text>
              {customError && <Text color="red">{customError}</Text>}
              {customPicks.length === 4 && !customError && (
                <Text color="green">Press Enter to confirm.</Text>
              )}
            </Box>
          ) : (
            <>
              {oppBringPred && (
                <Text color="magenta">
                  Likely opp bring: <Text bold>{oppBringPred.likely.map(m => m.species).join('/')}</Text> <Text dimColor>(conf {Math.round(oppBringPred.confidence * 100)}%{oppBringPred.alternatives[0] ? ` · also ${oppBringPred.alternatives[0].bring.map(m => m.species).join('/')}` : ''})</Text>
                </Text>
              )}
              {oppLead && (
                <Text color="magenta">
                  Likely opp lead: {oppLead.species[0]} + {oppLead.species[1]} <Text dimColor>— their strongest pair combo: {oppLead.tactic.name} ({tacticLabel(oppLead.tactic)})</Text>
                </Text>
              )}
              {nash && (
                <Box flexDirection="column" marginBottom={1}>
                  <Text bold color="green">◈ Sim bring — Nash {pctStr(nash.value)}{nash.exact ? '' : <Text color="yellow"> (approx · borrowed from {nash.anchor})</Text>}</Text>
                  <Text>   safest {pctStr(nash.maximinValue)}: <Text bold>{nash.maximinBring.join('/')}</Text></Text>
                  {nash.mix.slice(0, 3).map((m, i) => (
                    <Text key={`nx-${i}`} dimColor>   {pctStr(m.p).padStart(4)} {m.bring.join('/')}</Text>
                  ))}
                  {!nash.exact && nash.noAnalog.length > 0 && (
                    <Text color="red">   ⚠ no safe analog: {nash.noAnalog.join(', ')} — treat as rough</Text>
                  )}
                </Box>
              )}
              <Text bold>Suggested brings (type-matchup weighted)</Text>
              {brings.length === 0 && <Text dimColor>Scoring brings…</Text>}
              {brings.map((b, i) => {
                const mons = b.myIndices.map(idx => myTeam[idx]!.species).join(' + ');
                return (
                  <Box key={i} flexDirection="column">
                    <Text color={i === cursor ? 'yellow' : undefined}>
                      {i === cursor ? '>' : ' '} {i + 1}. {mons}  <Text dimColor>[total {b.total}]</Text>
                    </Text>
                    <Text dimColor>     match {b.matchup} · off {b.offense} · def {b.defense} · spd {b.speed} · roles {b.roles} · tactics {b.tactics} · threats {b.threats}</Text>
                    {/* Combo + threat detail only for the highlighted bring —
                        inline-joining every rationale made rows unreadable. */}
                    {i === cursor && b.rationale.map((r, k) => (
                      <Text key={k} dimColor={!r.startsWith('⚠')} color={r.startsWith('⚠') ? 'red' : r.startsWith('Combo') ? 'cyan' : undefined}>       {r}</Text>
                    ))}
                  </Box>
                );
              })}
            </>
          )}

          {effectiveIndices && grid.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Matchup (my STAB+coverage → opp)</Text>
              <Text>
                {'         '}
                {opponent.map((o, j) => (
                  <Text key={`hdr-${j}`} dimColor>{shortName(o.species, 5)} </Text>
                ))}
              </Text>
              {effectiveIndices.map((idx, row) => (
                <Text key={`row-${row}`}>
                  {shortName(myTeam[idx]!.species, 8)} {' '}
                  {grid[row]!.map((m, col) => (
                    <Text key={`c-${row}-${col}`} color={multColor(m)}>{fmtMult(m)}  </Text>
                  ))}
                </Text>
              ))}
            </Box>
          )}

          {threats.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Threats to your bring <Text dimColor>(their move → your mon)</Text></Text>
              {threats.map((t, i) => (
                <Text key={`th-${i}`} color={t.se ? 'red' : undefined}>
                  {t.se ? '⚠' : ' '} {shortName(t.species, 12)} <Text dimColor>{(t.se ? `${t.se.mult}× ${t.se.type}→${t.se.target}` : '').padEnd(18)}</Text> <Text dimColor>{`{${t.roles.join(',') || 'atk'}}`}{t.inferred ? ' *inf' : ''}{!t.known ? ' (unknown)' : ''}</Text>
                </Text>
              ))}
            </Box>
          )}
        </Box>
      </Box>

      {explaining && <Box marginTop={1}><PikaSpinner label="Pikachu is mulling over your team…" /></Box>}
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
