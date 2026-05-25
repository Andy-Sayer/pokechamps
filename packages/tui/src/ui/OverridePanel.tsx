import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Match, FieldState } from '@pokechamps/core/domain/types.js';
import { NEUTRAL_FIELD } from '@pokechamps/core/domain/types.js';
import { maxHpFor } from '@pokechamps/core/domain/damage.js';

// God-mode state editor (`/override`). Lets the user fix up anything the
// turn-by-turn logging drifted on: field state (weather / terrain / Trick Room
// / Tailwind), which mon is in each active slot, and per-active HP / status /
// stat boosts. HP is edited as RAW on my side, PERCENT on the opp side (the
// units the user actually reads). Nothing is inferred — this is manual ground
// truth, applied directly to the Match on Enter.
//
// Keys: ↑/↓ pick a row · ←/→ change · type digits to set an HP row · Enter
// applies everything · Esc cancels.

export type ActiveIdxLite = { mine: [number | null, number | null]; theirs: [number | null, number | null] };

const WEATHERS: Array<FieldState['weather']> = [null, 'Sun', 'Rain', 'Sand', 'Snow'];
const TERRAINS: Array<FieldState['terrain']> = [null, 'Electric', 'Grassy', 'Misty', 'Psychic'];
const STATUSES: Array<'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz' | undefined> =
  [undefined, 'brn', 'par', 'psn', 'tox', 'slp', 'frz'];
const BOOST_STATS = ['atk', 'def', 'spa', 'spd', 'spe'] as const;
type BoostStat = typeof BOOST_STATS[number];

interface SlotDraft {
  side: 'mine' | 'theirs';
  slot: 0 | 1;
  teamIndex: number | null;
  hp: number; // mine = raw, opp = percent
  status: 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz' | undefined;
  boosts: Record<BoostStat, number>;
}

export interface Draft {
  weather: FieldState['weather'];
  weatherTurns: number;   // 0 = untracked/none
  terrain: FieldState['terrain'];
  trickRoom: boolean;
  trickRoomTurns: number; // 0 = untracked/none
  twMine: boolean;
  twMineTurns: number;    // 0 = untracked/none; only written when twMine is on
  twTheirs: boolean;
  twTheirsTurns: number;  // 0 = untracked/none; only written when twTheirs is on
  slots: SlotDraft[];
}

function speciesFor(match: Match, side: 'mine' | 'theirs', idx: number | null): string {
  if (idx == null) return '—';
  return side === 'mine'
    ? match.myTeam[idx]?.species ?? `#${idx + 1}`
    : match.opponentTeam[idx]?.species ?? `#${idx + 1}`;
}

function maxHpForSlot(match: Match, side: 'mine' | 'theirs', idx: number | null): number {
  if (side !== 'mine' || idx == null) return 100;
  const set = match.myTeam[idx];
  return set ? maxHpFor(set) : 100;
}

// Pure application of a draft back onto the Match — exported for tests. HP
// converts raw→percent on my side; opp HP is already percent. Occupant changes
// reposition the active slots; opp occupants grow opponentBrought.
export function applyOverride(
  match: Match,
  activeIdx: ActiveIdxLite,
  draft: Draft,
): { match: Match; activeIdx: ActiveIdxLite } {
  const nextField: FieldState = {
    ...(match.field ?? NEUTRAL_FIELD),
    weather: draft.weather,
    weatherTurns: draft.weather && draft.weatherTurns > 0 ? draft.weatherTurns : undefined,
    terrain: draft.terrain,
    trickRoom: draft.trickRoom,
    trickRoomTurns: draft.trickRoom && draft.trickRoomTurns > 0 ? draft.trickRoomTurns : undefined,
    myTailwind: draft.twMine,
    myTailwindTurns: draft.twMine && draft.twMineTurns > 0 ? draft.twMineTurns : undefined,
    theirTailwind: draft.twTheirs,
    theirTailwindTurns: draft.twTheirs && draft.twTheirsTurns > 0 ? draft.twTheirsTurns : undefined,
  };
  const next: Match = {
    ...match,
    field: nextField,
    opponentTeam: match.opponentTeam.map(o => ({ ...o })),
    myCurrentHp: { ...(match.myCurrentHp ?? {}) },
    myStatus: { ...(match.myStatus ?? {}) },
    myBoosts: { ...(match.myBoosts ?? {}) },
    myFainted: [...(match.myFainted ?? [])],
  };
  const nextActive: ActiveIdxLite = {
    mine: [activeIdx.mine[0], activeIdx.mine[1]],
    theirs: [activeIdx.theirs[0], activeIdx.theirs[1]],
  };
  const broughtSet = new Set(next.opponentBrought ?? []);
  for (const s of draft.slots) {
    if (s.side === 'mine') nextActive.mine[s.slot] = s.teamIndex;
    else nextActive.theirs[s.slot] = s.teamIndex;
    if (s.teamIndex == null) continue;
    if (s.side === 'mine') {
      const mx = maxHpForSlot(match, 'mine', s.teamIndex);
      const pct = mx > 0 ? Math.max(0, Math.min(100, (s.hp / mx) * 100)) : 0;
      next.myCurrentHp![s.teamIndex] = pct;
      if (pct === 0) { if (!next.myFainted!.includes(s.teamIndex)) next.myFainted!.push(s.teamIndex); }
      else next.myFainted = next.myFainted!.filter(i => i !== s.teamIndex);
      if (s.status) next.myStatus![s.teamIndex] = s.status; else delete next.myStatus![s.teamIndex];
      next.myBoosts![s.teamIndex] = { ...s.boosts };
    } else {
      const o = next.opponentTeam[s.teamIndex]!;
      o.currentHpPercent = s.hp;
      o.fainted = s.hp === 0;
      o.status = s.status;
      o.currentBoosts = { ...s.boosts };
      broughtSet.add(s.teamIndex as any);
    }
  }
  next.opponentBrought = [...broughtSet].sort((a, b) => a - b) as Match['opponentBrought'];
  return { match: next, activeIdx: nextActive };
}

export function buildDraft(match: Match, activeIdx: ActiveIdxLite): Draft {
  const f = match.field ?? NEUTRAL_FIELD;
  const mk = (side: 'mine' | 'theirs', slot: 0 | 1): SlotDraft => {
    const idx = side === 'mine' ? activeIdx.mine[slot] : activeIdx.theirs[slot];
    let hp = 100;
    if (idx != null) {
      if (side === 'mine') {
        const pct = match.myCurrentHp?.[idx] ?? 100;
        hp = Math.round((pct / 100) * maxHpForSlot(match, side, idx));
      } else {
        hp = Math.round(match.opponentTeam[idx]?.currentHpPercent ?? 100);
      }
    }
    const rawBoosts = side === 'mine'
      ? match.myBoosts?.[idx ?? -1]
      : (idx != null ? match.opponentTeam[idx]?.currentBoosts : undefined);
    const boosts = Object.fromEntries(BOOST_STATS.map(s => [s, (rawBoosts as any)?.[s] ?? 0])) as Record<BoostStat, number>;
    const status = side === 'mine'
      ? match.myStatus?.[idx ?? -1]
      : (idx != null ? match.opponentTeam[idx]?.status : undefined);
    return { side, slot, teamIndex: idx ?? null, hp, status, boosts };
  };
  return {
    weather: f.weather ?? null,
    weatherTurns: f.weatherTurns ?? 0,
    terrain: f.terrain ?? null,
    trickRoom: !!f.trickRoom,
    trickRoomTurns: f.trickRoomTurns ?? 0,
    twMine: !!f.myTailwind,
    twMineTurns: f.myTailwindTurns ?? 0,
    twTheirs: !!f.theirTailwind,
    twTheirsTurns: f.theirTailwindTurns ?? 0,
    slots: [mk('mine', 0), mk('mine', 1), mk('theirs', 0), mk('theirs', 1)],
  };
}

// One navigable property line inside a target's editor. `change` cycles the
// value with ←/→; `setText` resolves a typed buffer to a value (so you can
// type "brn" / "sun" / "+2" / a species name instead of arrowing).
interface PropRow {
  label: string;
  display: string;
  change: (dir: 1 | -1) => void;
  setText?: (text: string) => void;
}

function cycle<T>(arr: T[], cur: T, dir: 1 | -1): T {
  const i = arr.findIndex(x => x === cur);
  const n = ((i < 0 ? 0 : i) + dir + arr.length) % arr.length;
  return arr[n]!;
}

// Resolve a typed buffer to one of `entries` by case-insensitive prefix.
// "none"/"clear"/"-"/"x" select the entry labelled 'none' (the empty value).
// Returns null when nothing matches (so the caller leaves the value alone).
function resolveEnum<T>(text: string, entries: Array<{ value: T; label: string }>): { value: T } | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  if (['none', 'clear', '-', 'x'].includes(t)) {
    const clear = entries.find(e => e.label.toLowerCase() === 'none');
    if (clear) return { value: clear.value };
  }
  const hit = entries.find(e => e.label.toLowerCase().startsWith(t));
  return hit ? { value: hit.value } : null;
}

const clampStage = (n: number) => Math.max(-6, Math.min(6, n));

const slotTag = (s: SlotDraft) => `${s.side === 'mine' ? 'm' : 'o'}${s.slot + 1}`;
const boostSummary = (b: Record<BoostStat, number>) =>
  BOOST_STATS.filter(s => b[s] !== 0).map(s => `${b[s] > 0 ? '+' : ''}${b[s]} ${s}`).join(' ');

// Two-step editor: a target list (Field / m1 / m2 / o1 / o2) → drill into one
// target's short property list. Far less scrolling than a flat 33-row list,
// and HP entry replaces (first digit clears) instead of appending.
export function OverridePanel(props: {
  match: Match;
  activeIdx: ActiveIdxLite;
  onApply: (match: Match, activeIdx: ActiveIdxLite) => void;
  onClose: () => void;
}): React.ReactElement {
  const { match, activeIdx } = props;
  const [draft, setDraft] = useState<Draft>(() => buildDraft(match, activeIdx));
  const [mode, setMode] = useState<'list' | 'edit'>('list');
  const [listSel, setListSel] = useState(0);
  const [editTarget, setEditTarget] = useState<'field' | number>('field');
  const [editSel, setEditSel] = useState(0);
  // Typed-entry buffer for the focused row. Empty = not typing; resets on any
  // navigation. Resolved live to a value via the row's setText.
  const [buf, setBuf] = useState('');

  const set = (patch: Partial<Draft>) => setDraft(d => ({ ...d, ...patch }));
  const setSlot = (i: number, patch: Partial<SlotDraft>) =>
    setDraft(d => ({ ...d, slots: d.slots.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));

  const occupantsFor = (side: 'mine' | 'theirs'): Array<number | null> => {
    const team = side === 'mine' ? match.myTeam : match.opponentTeam;
    return [null, ...team.map((_, i) => i)];
  };

  // ---- target list summaries ----
  const fieldSummary =
    `${draft.weather ?? 'none'} · ${draft.terrain ?? 'none'} · TR ${draft.trickRoom ? 'on' : 'off'} · TW ${draft.twMine ? 'my' : '–'}/${draft.twTheirs ? 'opp' : '–'}`;
  const slotSummary = (s: SlotDraft): string => {
    if (s.teamIndex == null) return 'empty';
    const sp = speciesFor(match, s.side, s.teamIndex);
    const hp = s.side === 'mine' ? `${s.hp}/${maxHpForSlot(match, 'mine', s.teamIndex)}` : `${s.hp}%`;
    const bits = [sp, hp, s.status ?? '', boostSummary(s.boosts)].filter(Boolean);
    return bits.join('  ');
  };
  const targets = [
    { id: 'field' as const, label: 'Field', summary: fieldSummary },
    ...draft.slots.map((s, i) => ({ id: i, label: slotTag(s), summary: slotSummary(s) })),
  ];
  const APPLY = targets.length;
  const CANCEL = targets.length + 1;
  const listLen = targets.length + 2;

  // ---- property rows for the current edit target ----
  const weatherEntries = WEATHERS.map(w => ({ value: w, label: w ?? 'none' }));
  const terrainEntries = TERRAINS.map(t => ({ value: t, label: t ?? 'none' }));
  const boolEntries = [{ value: true, label: 'on' }, { value: false, label: 'off' }];
  const statusEntries = STATUSES.map(s => ({ value: s, label: s ?? 'none' }));

  const fieldProps = (): PropRow[] => [
    { label: 'Weather', display: draft.weather ?? 'none', change: d => set({ weather: cycle(WEATHERS, draft.weather, d) }), setText: t => { const r = resolveEnum(t, weatherEntries); if (r) set({ weather: r.value }); } },
    { label: 'Weather turns', display: draft.weatherTurns > 0 ? String(draft.weatherTurns) : '—', change: d => set({ weatherTurns: Math.max(0, draft.weatherTurns + d) }), setText: t => { const n = t.replace(/\D/g, ''); set({ weatherTurns: n ? Number(n) : 0 }); } },
    { label: 'Terrain', display: draft.terrain ?? 'none', change: d => set({ terrain: cycle(TERRAINS, draft.terrain, d) }), setText: t => { const r = resolveEnum(t, terrainEntries); if (r) set({ terrain: r.value }); } },
    { label: 'Trick Room', display: draft.trickRoom ? 'on' : 'off', change: () => set({ trickRoom: !draft.trickRoom }), setText: t => { const r = resolveEnum(t, boolEntries); if (r) set({ trickRoom: r.value }); } },
    { label: 'Trick Room turns', display: draft.trickRoomTurns > 0 ? String(draft.trickRoomTurns) : '—', change: d => set({ trickRoomTurns: Math.max(0, draft.trickRoomTurns + d) }), setText: t => { const n = t.replace(/\D/g, ''); set({ trickRoomTurns: n ? Number(n) : 0 }); } },
    { label: 'Tailwind (mine)', display: draft.twMine ? 'on' : 'off', change: () => set({ twMine: !draft.twMine }), setText: t => { const r = resolveEnum(t, boolEntries); if (r) set({ twMine: r.value }); } },
    { label: 'TW (mine) turns', display: draft.twMineTurns > 0 ? String(draft.twMineTurns) : '—', change: d => set({ twMineTurns: Math.max(0, draft.twMineTurns + d) }), setText: t => { const n = t.replace(/\D/g, ''); set({ twMineTurns: n ? Number(n) : 0 }); } },
    { label: 'Tailwind (opp)', display: draft.twTheirs ? 'on' : 'off', change: () => set({ twTheirs: !draft.twTheirs }), setText: t => { const r = resolveEnum(t, boolEntries); if (r) set({ twTheirs: r.value }); } },
    { label: 'TW (opp) turns', display: draft.twTheirsTurns > 0 ? String(draft.twTheirsTurns) : '—', change: d => set({ twTheirsTurns: Math.max(0, draft.twTheirsTurns + d) }), setText: t => { const n = t.replace(/\D/g, ''); set({ twTheirsTurns: n ? Number(n) : 0 }); } },
  ];
  const slotProps = (i: number): PropRow[] => {
    const s = draft.slots[i]!;
    const opts = occupantsFor(s.side);
    const occEntries = opts.map(o => ({ value: o, label: o == null ? 'none' : speciesFor(match, s.side, o) }));
    const rows: PropRow[] = [{
      label: 'Occupant',
      display: speciesFor(match, s.side, s.teamIndex),
      change: d => setSlot(i, { teamIndex: cycle(opts, s.teamIndex, d) }),
      setText: t => { const r = resolveEnum(t, occEntries); if (r) setSlot(i, { teamIndex: r.value }); },
    }];
    if (s.teamIndex == null) return rows;
    const mx = s.side === 'mine' ? maxHpForSlot(match, 'mine', s.teamIndex) : 100;
    rows.push({
      label: 'HP',
      display: s.side === 'mine' ? `${s.hp}/${mx}` : `${s.hp}%`,
      change: d => setSlot(i, { hp: Math.max(0, Math.min(mx, s.hp + d)) }),
      setText: t => { const digits = t.replace(/\D/g, ''); setSlot(i, { hp: digits ? Math.max(0, Math.min(mx, Number(digits))) : 0 }); },
    });
    rows.push({
      label: 'Status', display: s.status ?? 'none',
      change: d => setSlot(i, { status: cycle(STATUSES, s.status, d) }),
      setText: t => { const r = resolveEnum(t, statusEntries); if (r) setSlot(i, { status: r.value }); },
    });
    for (const stat of BOOST_STATS) {
      rows.push({
        label: stat,
        display: s.boosts[stat] > 0 ? `+${s.boosts[stat]}` : `${s.boosts[stat]}`,
        change: d => setSlot(i, { boosts: { ...s.boosts, [stat]: clampStage(s.boosts[stat] + d) } }),
        setText: t => { const m = t.match(/^([+-]?)(\d+)$/); if (m) setSlot(i, { boosts: { ...s.boosts, [stat]: clampStage((m[1] === '-' ? -1 : 1) * Number(m[2])) } }); },
      });
    }
    return rows;
  };
  const editRows: PropRow[] = mode === 'edit'
    ? (editTarget === 'field' ? fieldProps() : slotProps(editTarget))
    : [];
  const editSelClamped = Math.min(editSel, Math.max(0, editRows.length - 1));

  const apply = () => {
    const { match: nextMatch, activeIdx: nextActive } = applyOverride(match, activeIdx, draft);
    props.onApply(nextMatch, nextActive);
  };

  useInput((ch, key) => {
    if (mode === 'list') {
      if (key.escape) { props.onClose(); return; }
      if (key.upArrow) { setListSel(s => Math.max(0, s - 1)); return; }
      if (key.downArrow) { setListSel(s => Math.min(listLen - 1, s + 1)); return; }
      if (key.return) {
        if (listSel === CANCEL) { props.onClose(); return; }
        if (listSel === APPLY) { apply(); return; }
        setEditTarget(targets[listSel]!.id);
        setEditSel(0);
        setBuf('');
        setMode('edit');
      }
      return;
    }
    // edit mode
    if (key.escape || key.return) { setMode('list'); setBuf(''); return; }
    if (key.upArrow) { setEditSel(s => Math.max(0, s - 1)); setBuf(''); return; }
    if (key.downArrow) { setEditSel(s => Math.min(editRows.length - 1, s + 1)); setBuf(''); return; }
    const row = editRows[editSelClamped];
    if (key.leftArrow) { setBuf(''); row?.change(-1); return; }
    if (key.rightArrow) { setBuf(''); row?.change(1); return; }
    if (key.backspace || key.delete) {
      const nb = buf.slice(0, -1);
      setBuf(nb);
      row?.setText?.(nb);
      return;
    }
    // Any other printable character is typed entry — resolve it live.
    if (ch && /^[\x20-\x7e]$/.test(ch) && row?.setText) {
      const nb = buf + ch;
      setBuf(nb);
      row.setText(nb);
    }
  });

  if (mode === 'list') {
    return (
      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="magenta" paddingX={1}>
        <Text bold color="magenta">/override — pick a target</Text>
        <Text dimColor>↑/↓ pick · Enter to edit · Esc cancels</Text>
        <Box flexDirection="column" marginTop={1}>
          {targets.map((t, i) => (
            <Text key={t.label} color={i === listSel ? 'cyan' : undefined} inverse={i === listSel}>
              {i === listSel ? '› ' : '  '}{t.label.padEnd(7)} <Text dimColor>{t.summary}</Text>
            </Text>
          ))}
          <Text> </Text>
          <Text color={listSel === APPLY ? 'green' : undefined} inverse={listSel === APPLY}>
            {listSel === APPLY ? '› ' : '  '}✓ Apply changes
          </Text>
          <Text color={listSel === CANCEL ? 'red' : undefined} inverse={listSel === CANCEL}>
            {listSel === CANCEL ? '› ' : '  '}✗ Cancel
          </Text>
        </Box>
      </Box>
    );
  }

  const targetLabel = editTarget === 'field'
    ? 'Field'
    : `${slotTag(draft.slots[editTarget]!)} ${speciesFor(match, draft.slots[editTarget]!.side, draft.slots[editTarget]!.teamIndex)}`;
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">/override — {targetLabel}</Text>
      <Text dimColor>↑/↓ pick · ←/→ change · type to set (e.g. brn / sun / +2 / a species) · Enter/Esc back</Text>
      <Box flexDirection="column" marginTop={1}>
        {editRows.map((r, i) => (
          <Text key={r.label} color={i === editSelClamped ? 'cyan' : undefined} inverse={i === editSelClamped}>
            {i === editSelClamped ? '› ' : '  '}{r.label.padEnd(12)} {r.display}{i === editSelClamped && buf ? ` ‹${buf}›` : ''}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
