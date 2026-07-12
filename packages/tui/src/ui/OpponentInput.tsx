import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { OpponentEntry } from '@pokechamps/core/domain/types.js';
import { searchLegalSpecies, toId } from '@pokechamps/core/domain/data.js';
import type { Stores } from '@pokechamps/core/storage/index.js';
// Type-only import (erased at runtime); the vision module loads lazily on Ctrl+R.
import type { OppSlotRead } from '@pokechamps/vision/oppTeamRead.js';
import { isWatching as watcherIsWatching, onWatchingChange } from './watcher.js';

export interface OpponentInputProps {
  stores: Stores;
  onDone: (opp: OpponentEntry[]) => void;
  onCancel: () => void;
}

const SIZE = 6;
const SUGGESTION_LIMIT = 8;
const CONF = 0.7;        // vision score at/above this is auto-trusted (no ⚠, not flagged for review)
const CONFIRMED = 1;     // sentinel: a human set/accepted this slot

export function OpponentInput({ stores, onDone, onCancel }: OpponentInputProps) {
  const [species, setSpecies] = useState<string[]>(Array(SIZE).fill(''));
  const [scores, setScores] = useState<number[]>(Array(SIZE).fill(0)); // 0 empty · 0<x<1 vision · 1 confirmed
  const [activeIdx, setActiveIdx] = useState(0);
  const [value, setValue] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [reading, setReading] = useState(false);
  const [visionMsg, setVisionMsg] = useState('');
  const [slotTypes, setSlotTypes] = useState<string[]>(Array(SIZE).fill(''));   // read type combo per slot
  const [slotCands, setSlotCands] = useState<string[][]>(Array(SIZE).fill([]));  // type-combo candidate species
  const [trusted, setTrusted] = useState<boolean[]>(Array(SIZE).fill(false));    // type-verified or human-set = settled

  const typing = value.trim() !== '';

  const chosenIds = useMemo(() => {
    const s = new Set<string>();
    for (let i = 0; i < species.length; i++) if (i !== activeIdx && species[i]) s.add(toId(species[i]!));
    return s;
  }, [species, activeIdx]);

  const suggestions = useMemo(
    () => typing
      ? searchLegalSpecies(value, SUGGESTION_LIMIT + chosenIds.size).filter(n => !chosenIds.has(toId(n))).slice(0, SUGGESTION_LIMIT)
      : [],
    [value, chosenIds, typing],
  );
  useMemo(() => setHighlight(0), [value]);
  const framePathRef = useRef<string | null>(null);   // the frame we snapshotted + read (harvested on confirm)

  // A slot is settled iff it's TYPE-VERIFIED (sprite+type agree, or types pin a single
  // legal species) or a human set it (`trusted`). A bare sprite guess is NOT trusted — the
  // type combo guards against the cross-type false-positive (Morpeko→"Mawile") that made raw
  // sprite scores untrustworthy. Empty/untrusted slots still need a human pick.
  const needsAttention = (i: number) => !species[i]?.trim() || !trusted[i];
  const nextAttention = (from: number): number => {
    for (let k = 0; k < SIZE; k++) { const i = (from + k) % SIZE; if (needsAttention(i)) return i; }
    return -1;
  };

  const moveSlot = (d: number) => { setActiveIdx(i => Math.max(0, Math.min(SIZE - 1, i + d))); setValue(''); setHighlight(0); };

  const commit = (name: string) => {
    const next = species.slice(); next[activeIdx] = name; setSpecies(next);
    const sc = scores.slice(); sc[activeIdx] = CONFIRMED; setScores(sc);
    const tr = trusted.slice(); tr[activeIdx] = true; setTrusted(tr);
    setValue(''); setHighlight(0);
    stores.pikalytics.fetchAndCache(name);
    // Jump to the next slot still needing a pick (empty or untrusted); stay put if none.
    const nx = (() => { for (let k = 1; k <= SIZE; k++) { const i = (activeIdx + k) % SIZE; if (!next[i]?.trim() || !tr[i]) return i; } return -1; })();
    if (nx >= 0) setActiveIdx(nx);
  };

  const finish = () => {
    if (species.every(s => s.trim())) {
      // Self-improve: harvest a sprite ref from each TRUSTED pick (type-verified or user-set —
      // never a bare sprite guess, which could be wrong) so future reads of these species match
      // automatically. Fire-and-forget — never blocks confirming.
      const path = framePathRef.current;
      if (path) {
        const ground = species.map((s, i) => (trusted[i] ? s : null));
        void import('@pokechamps/vision/harvestRefs.js').then(m => m.harvestConfirmedRefs(path, ground)).catch(() => {});
      }
      onDone(species.map(s => ({ species: s, knownMoves: [] }))); return;
    }
    const empty = species.findIndex(s => !s.trim());
    setActiveIdx(empty); setVisionMsg('some slots are still empty — fill them, then Ctrl+D');
  };

  const readBusy = useRef(false);
  const doRead = async (quiet = false): Promise<'ok' | 'no-preview' | 'error'> => {
    if (readBusy.current) return 'error';
    readBusy.current = true;
    setReading(true); if (!quiet) setVisionMsg('reading opponent off the live screen…');
    try {
      // Freeze the frame we read so the SAME one is harvested on confirm (the 4fps tap keeps
      // changing during the 15-30s pick window).
      const { snapshotLiveFrame } = await import('@pokechamps/vision/harvestRefs.js');
      framePathRef.current = snapshotLiveFrame();
      const { readOppTeamFromFrame, saveChooserDebug, archiveOppSheet } = await import('@pokechamps/vision/oppTeamRead.js');
      const got: OppSlotRead[] = await readOppTeamFromFrame(framePathRef.current);
      saveChooserDebug(framePathRef.current, got);   // persist the exact frame + result for offline diagnosis
      // Durably archive the sheet (timestamped, never clobbered) so its sprites can be harvested
      // later. Auto-read reaches here once per detection; manual Ctrl+R saves on each press.
      const archivedPath = archiveOppSheet(framePathRef.current, got);
      const isVerified = (g: OppSlotRead) => g.source === 'sprite+type' || g.source === 'type-only';
      setSpecies(got.map(g => g.name || ''));
      setScores(got.map(g => g.score));
      setSlotTypes(got.map(g => g.types.join('/')));
      setSlotCands(got.map(g => g.candidates));
      setTrusted(got.map(isVerified));
      setValue('');
      const verified = got.filter(isVerified).length;
      const first = got.findIndex(g => !isVerified(g));
      setActiveIdx(first >= 0 ? first : 0);
      setVisionMsg(`read done — ${verified}/6 type-verified (trusted ✓). Pick the rest (↑/↓, type/Tab), Ctrl+D confirms.${archivedPath ? ' · sheet saved ✓' : ''}${watcherIsWatching() ? '' : ' · Ctrl+W to watch the whole battle.'}`);
      return 'ok';
    } catch (e) {
      const m = (e as Error).message;
      // Persist the rejected frame too — if the gate is wrongly refusing a real chooser, this is
      // the evidence to recalibrate on.
      try { if (framePathRef.current) { const { saveChooserDebug } = await import('@pokechamps/vision/oppTeamRead.js'); saveChooserDebug(framePathRef.current, { error: m }); } } catch { /* ignore */ }
      if (/no team-preview/i.test(m)) { if (!quiet) setVisionMsg('no chooser on screen yet — point the capture at the "Select 4 Pokémon" screen.'); return 'no-preview'; }
      if (!quiet) setVisionMsg(`vision read failed: ${m} — is the capture server up?`);
      return 'error';
    } finally {
      setReading(false); readBusy.current = false;
    }
  };
  const runVisionRead = () => void doRead(false);          // manual Ctrl+R (loud, one-shot)

  // Ctrl+W ("watch everything") is a GLOBAL toggle in cli.tsx; watching the whole battle
  // INCLUDES the opponent read. While the watcher is on, POLL quietly and RETRY until the
  // game's chooser screen actually appears, then read it once — hands-free (the user may reach
  // this screen before the game shows the "Select 4" preview). Ctrl+R stays a manual one-off.
  const autoRead = useRef(false);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (stopped || !watcherIsWatching()) return;
      const r = await doRead(true);
      if (r === 'ok' || stopped) return;                     // got the chooser (or unmounted) → stop
      timer = setTimeout(poll, 1500);                         // chooser/server not up yet → retry
    };
    const start = () => { if (!autoRead.current) { autoRead.current = true; setVisionMsg('watching — will read the opponent when the chooser screen appears…'); void poll(); } };
    if (watcherIsWatching()) start();
    const off = onWatchingChange(on => { if (on) start(); else autoRead.current = false; });
    return () => { stopped = true; if (timer) clearTimeout(timer); off(); };
  }, []);

  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.ctrl && (input === 'r' || input === 'R')) { void runVisionRead(); return; }        // manual snapshot read
    if (key.ctrl && (input === 'd' || input === 'D')) { finish(); return; }                     // done
    // ↑/↓: cycle suggestions while typing, else move between the 6 slots.
    if (key.upArrow)   { typing ? setHighlight(h => Math.max(0, h - 1)) : moveSlot(-1); return; }
    if (key.downArrow) { typing ? setHighlight(h => Math.min(suggestions.length - 1, h + 1)) : moveSlot(1); return; }
    if (key.tab && suggestions.length) {
      setHighlight(h => key.shift ? (h - 1 + suggestions.length) % suggestions.length : (h + 1) % suggestions.length);
    }
  });

  const onSubmit = (v: string) => {
    if (!v.trim()) { const nx = nextAttention(activeIdx + 1); if (nx >= 0) setActiveIdx(nx); return; } // Enter on empty = skip ahead
    const picked = suggestions[highlight] ?? v.trim();
    if (!picked || chosenIds.has(toId(picked))) return;
    commit(picked);
  };

  const badge = (i: number) => {
    const ty = slotTypes[i] ? ` ${slotTypes[i]}` : '';
    if (trusted[i]) return <Text color="green"> ✓{ty}</Text>;                                  // type-verified or human-set
    if (species[i]) return <Text color="yellow"> {Math.round((scores[i] ?? 0) * 100)}% verify{ty}</Text>; // bare sprite guess
    const cands = slotCands[i] ?? [];                                                          // no species yet → show shortlist
    if (slotTypes[i]) return <Text color="cyan"> {slotTypes[i]} → {cands.length ? (cands.length <= 4 ? cands.join('/') : `${cands.length} candidates`) : 'no match — type it'}</Text>;
    return <Text dimColor> (empty)</Text>;
  };

  const attentionLeft = species.filter((_, i) => needsAttention(i)).length;

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Opponent team — the 6 species from preview</Text>
      <Text color="magenta"><Text bold>Ctrl+R</Text> reads type icons + sprites · <Text color="green">✓</Text>=type-verified (trusted), others show <Text color="cyan">type→candidates</Text> · <Text bold>Ctrl+D</Text> confirms</Text>
      <Text dimColor>↑/↓ move · type to set from the candidates (Tab cycles) · Enter · ESC cancel</Text>

      {(reading || visionMsg) && (
        <Box marginTop={1}><Text color={reading ? 'yellow' : 'gray'}>{reading ? '⏳ ' : ''}{visionMsg}</Text></Box>
      )}

      <Box flexDirection="column" marginTop={1}>
        {species.map((s, i) => (
          <Text key={i} color={i === activeIdx ? 'yellow' : undefined} bold={i === activeIdx}>
            {i === activeIdx ? '❯ ' : '  '}{i + 1}. {s || ''}{badge(i)}
          </Text>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text color="yellow">Set #{activeIdx + 1}: </Text>
        <TextInput value={value} onChange={setValue} onSubmit={onSubmit}
          placeholder={species[activeIdx]
            ? `${species[activeIdx]} — Enter to keep, or type to replace`
            : (slotCands[activeIdx]?.length ? `${slotTypes[activeIdx]} → ${slotCands[activeIdx]!.slice(0, 5).join(', ')}${slotCands[activeIdx]!.length > 5 ? '…' : ''}` : 'type a species…')} />
      </Box>

      {typing ? (
        <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
          {suggestions.length === 0
            ? <Text dimColor>No legal species match "{value}".</Text>
            : suggestions.map((name, i) => (
              <Text key={`${i}-${name}`} color={i === highlight ? 'green' : undefined}>{i === highlight ? '❯ ' : '  '}{name}</Text>
            ))}
        </Box>
      ) : (
        <Box marginTop={1}><Text dimColor>{attentionLeft ? `${attentionLeft} slot(s) to set (untrusted/empty) — ↑/↓ to reach them, pick from the candidates.` : 'all 6 settled — Ctrl+D.'}</Text></Box>
      )}
    </Box>
  );
}
