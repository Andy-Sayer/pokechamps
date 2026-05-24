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

// One navigable line. `change(dir)` mutates the draft; `display` renders the
// current value. HP rows additionally accept typed digits via `setHp`.
interface Row {
  label: string;
  display: string;
  change: (dir: 1 | -1) => void;
  hpRow?: { side: 'mine' | 'theirs'; slotIndex: number };
}

function cycle<T>(arr: T[], cur: T, dir: 1 | -1): T {
  const i = arr.findIndex(x => x === cur);
  const n = ((i < 0 ? 0 : i) + dir + arr.length) % arr.length;
  return arr[n]!;
}

export function OverridePanel(props: {
  match: Match;
  activeIdx: ActiveIdxLite;
  onApply: (match: Match, activeIdx: ActiveIdxLite) => void;
  onClose: () => void;
}): React.ReactElement {
  const { match, activeIdx } = props;
  const [draft, setDraft] = useState<Draft>(() => buildDraft(match, activeIdx));
  const [sel, setSel] = useState(0);

  const set = (patch: Partial<Draft>) => setDraft(d => ({ ...d, ...patch }));
  const setSlot = (i: number, patch: Partial<SlotDraft>) =>
    setDraft(d => ({ ...d, slots: d.slots.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));

  // Team-member cycle options for a side (null = leave empty).
  const occupantsFor = (side: 'mine' | 'theirs'): Array<number | null> => {
    const team = side === 'mine' ? match.myTeam : match.opponentTeam;
    return [null, ...team.map((_, i) => i)];
  };

  // Build the flat row list from the current draft each render.
  const rows: Row[] = [];
  rows.push({
    label: 'Weather', display: draft.weather ?? 'none',
    change: dir => set({ weather: cycle(WEATHERS, draft.weather, dir) }),
  });
  rows.push({
    label: 'Terrain', display: draft.terrain ?? 'none',
    change: dir => set({ terrain: cycle(TERRAINS, draft.terrain, dir) }),
  });
  rows.push({ label: 'Trick Room', display: draft.trickRoom ? 'on' : 'off', change: () => set({ trickRoom: !draft.trickRoom }) });
  rows.push({ label: 'Tailwind (mine)', display: draft.twMine ? 'on' : 'off', change: () => set({ twMine: !draft.twMine }) });
  rows.push({ label: 'Tailwind (opp)', display: draft.twTheirs ? 'on' : 'off', change: () => set({ twTheirs: !draft.twTheirs }) });

  draft.slots.forEach((s, i) => {
    const tag = `${s.side === 'mine' ? 'm' : 'o'}${s.slot + 1}`;
    const opts = occupantsFor(s.side);
    rows.push({
      label: `${tag} occupant`,
      display: speciesFor(match, s.side, s.teamIndex),
      change: dir => setSlot(i, { teamIndex: cycle(opts, s.teamIndex, dir) }),
    });
    if (s.teamIndex == null) return; // empty slot — nothing else to edit
    const unit = s.side === 'mine' ? '' : '%';
    const mx = s.side === 'mine' ? maxHpForSlot(match, s.side, s.teamIndex) : 100;
    rows.push({
      label: `${tag} HP`,
      display: `${s.hp}${unit}${s.side === 'mine' ? `/${mx}` : ''}`,
      change: dir => setSlot(i, { hp: Math.max(0, Math.min(mx, s.hp + dir)) }),
      hpRow: { side: s.side, slotIndex: i },
    });
    rows.push({
      label: `${tag} status`,
      display: s.status ?? 'none',
      change: dir => setSlot(i, { status: cycle(STATUSES, s.status, dir) }),
    });
    for (const stat of BOOST_STATS) {
      rows.push({
        label: `${tag} ${stat}`,
        display: (s.boosts[stat] > 0 ? `+${s.boosts[stat]}` : `${s.boosts[stat]}`),
        change: dir => setSlot(i, { boosts: { ...s.boosts, [stat]: Math.max(-6, Math.min(6, s.boosts[stat] + dir)) } }),
      });
    }
  });

  const selClamped = Math.min(sel, rows.length - 1);

  const apply = () => {
    const { match: nextMatch, activeIdx: nextActive } = applyOverride(match, activeIdx, draft);
    props.onApply(nextMatch, nextActive);
  };

  useInput((ch, key) => {
    if (key.escape) { props.onClose(); return; }
    if (key.return) { apply(); return; }
    if (key.upArrow) { setSel(s => Math.max(0, s - 1)); return; }
    if (key.downArrow) { setSel(s => Math.min(rows.length - 1, s + 1)); return; }
    if (key.leftArrow) { rows[selClamped]?.change(-1); return; }
    if (key.rightArrow) { rows[selClamped]?.change(1); return; }
    // Typed digits set an HP row directly (e.g. type "1","4","5" → 145).
    const hp = rows[selClamped]?.hpRow;
    if (hp && /[0-9]/.test(ch)) {
      const s = draft.slots[hp.slotIndex]!;
      const mx = hp.side === 'mine' ? maxHpForSlot(match, 'mine', s.teamIndex) : 100;
      const grown = Number(`${s.hp}${ch}`);
      setSlot(hp.slotIndex, { hp: Math.max(0, Math.min(mx, grown)) });
    } else if (hp && (key.backspace || key.delete)) {
      const s = draft.slots[hp.slotIndex]!;
      setSlot(hp.slotIndex, { hp: Math.floor(s.hp / 10) });
    }
  });

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">/override — manual state editor</Text>
      <Text dimColor>↑/↓ pick · ←/→ change · type digits to set HP · Enter applies · Esc cancels</Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.map((r, i) => (
          <Text key={r.label} color={i === selClamped ? 'cyan' : undefined} inverse={i === selClamped}>
            {i === selClamped ? '› ' : '  '}{r.label.padEnd(18)} {r.display}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
