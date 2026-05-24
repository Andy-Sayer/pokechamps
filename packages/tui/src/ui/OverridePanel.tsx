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
  terrain: FieldState['terrain'];
  trickRoom: boolean;
  twMine: boolean;
  twTheirs: boolean;
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
    terrain: draft.terrain,
    trickRoom: draft.trickRoom,
    myTailwind: draft.twMine,
    theirTailwind: draft.twTheirs,
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
    terrain: f.terrain ?? null,
    trickRoom: !!f.trickRoom,
    twMine: !!f.myTailwind,
    twTheirs: !!f.theirTailwind,
    slots: [mk('mine', 0), mk('mine', 1), mk('theirs', 0), mk('theirs', 1)],
  };
}

// One navigable property line inside a target's editor.
interface PropRow {
  label: string;
  display: string;
  change: (dir: 1 | -1) => void;
  isHp?: boolean;
  hpMax?: number;
}

function cycle<T>(arr: T[], cur: T, dir: 1 | -1): T {
  const i = arr.findIndex(x => x === cur);
  const n = ((i < 0 ? 0 : i) + dir + arr.length) % arr.length;
  return arr[n]!;
}

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
  // Active HP typing buffer for the focused HP row. null = not typing; the
  // first digit starts a fresh value (replace), further digits append.
  const [hpInput, setHpInput] = useState<string | null>(null);

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
  const fieldProps = (): PropRow[] => [
    { label: 'Weather', display: draft.weather ?? 'none', change: d => set({ weather: cycle(WEATHERS, draft.weather, d) }) },
    { label: 'Terrain', display: draft.terrain ?? 'none', change: d => set({ terrain: cycle(TERRAINS, draft.terrain, d) }) },
    { label: 'Trick Room', display: draft.trickRoom ? 'on' : 'off', change: () => set({ trickRoom: !draft.trickRoom }) },
    { label: 'Tailwind (mine)', display: draft.twMine ? 'on' : 'off', change: () => set({ twMine: !draft.twMine }) },
    { label: 'Tailwind (opp)', display: draft.twTheirs ? 'on' : 'off', change: () => set({ twTheirs: !draft.twTheirs }) },
  ];
  const slotProps = (i: number): PropRow[] => {
    const s = draft.slots[i]!;
    const opts = occupantsFor(s.side);
    const rows: PropRow[] = [{
      label: 'Occupant',
      display: speciesFor(match, s.side, s.teamIndex),
      change: d => setSlot(i, { teamIndex: cycle(opts, s.teamIndex, d) }),
    }];
    if (s.teamIndex == null) return rows;
    const mx = s.side === 'mine' ? maxHpForSlot(match, 'mine', s.teamIndex) : 100;
    rows.push({
      label: 'HP',
      display: s.side === 'mine' ? `${s.hp}/${mx}` : `${s.hp}%`,
      change: d => { setHpInput(null); setSlot(i, { hp: Math.max(0, Math.min(mx, s.hp + d)) }); },
      isHp: true,
      hpMax: mx,
    });
    rows.push({ label: 'Status', display: s.status ?? 'none', change: d => setSlot(i, { status: cycle(STATUSES, s.status, d) }) });
    for (const stat of BOOST_STATS) {
      rows.push({
        label: stat,
        display: s.boosts[stat] > 0 ? `+${s.boosts[stat]}` : `${s.boosts[stat]}`,
        change: d => setSlot(i, { boosts: { ...s.boosts, [stat]: Math.max(-6, Math.min(6, s.boosts[stat] + d)) } }),
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
        setHpInput(null);
        setMode('edit');
      }
      return;
    }
    // edit mode
    if (key.escape || key.return) { setMode('list'); setHpInput(null); return; }
    if (key.upArrow) { setEditSel(s => Math.max(0, s - 1)); setHpInput(null); return; }
    if (key.downArrow) { setEditSel(s => Math.min(editRows.length - 1, s + 1)); setHpInput(null); return; }
    const row = editRows[editSelClamped];
    if (key.leftArrow) { setHpInput(null); row?.change(-1); return; }
    if (key.rightArrow) { setHpInput(null); row?.change(1); return; }
    if (row?.isHp && typeof editTarget === 'number') {
      const mx = row.hpMax ?? 100;
      if (/[0-9]/.test(ch)) {
        const buf = (hpInput ?? '') + ch;
        setHpInput(buf);
        setSlot(editTarget, { hp: Math.max(0, Math.min(mx, Number(buf))) });
      } else if (key.backspace || key.delete) {
        const buf = (hpInput ?? '').slice(0, -1);
        setHpInput(buf);
        setSlot(editTarget, { hp: buf ? Math.max(0, Math.min(mx, Number(buf))) : 0 });
      }
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
      <Text dimColor>↑/↓ pick · ←/→ change{editRows[editSelClamped]?.isHp ? ' · type digits to set HP' : ''} · Enter/Esc back to list</Text>
      <Box flexDirection="column" marginTop={1}>
        {editRows.map((r, i) => (
          <Text key={r.label} color={i === editSelClamped ? 'cyan' : undefined} inverse={i === editSelClamped}>
            {i === editSelClamped ? '› ' : '  '}{r.label.padEnd(12)} {r.display}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
