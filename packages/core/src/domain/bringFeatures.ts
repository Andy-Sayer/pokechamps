// Engine-derived, TEAM-AGNOSTIC matchup features for the bring value model. The
// whole point (per the Step-0 finding): the static opening-search score is a
// strong but MISCALIBRATED signal — so we feed it to the model AS a feature
// alongside matchup aggregates the score can't express (the KO race, speed, type
// pressure), and let supervised learning on playout outcomes calibrate/correct it.
// Features describe the MATCHUP, not team identity, so a model trained on our
// team vs the meta can generalize across opponents.
import { searchIterative, type SearchInput } from './endgameSearch.js';
import { damageRange } from './damage.js';
import { effectiveness, speciesTypes } from './typechart.js';
import { getSpecies } from './data.js';
import { entryOf } from './teamSim.js';
import { NEUTRAL_FIELD, type FieldState } from './types.js';
import type { PokemonSet } from './types.js';

const baseStats = (sp: string) => (getSpecies(sp) as { baseStats?: Record<string, number> } | undefined)?.baseStats;

// Best max-roll damage % this attacker can deal to this defender over its moves
// (spread-aware: uses the real sets). Status/invalid moves contribute 0.
function bestDamagePct(attacker: PokemonSet, defender: PokemonSet, side: 'mine' | 'theirs', field: FieldState): number {
  let best = 0;
  for (const move of attacker.moves ?? []) {
    try {
      const r = damageRange({ attacker, defender, move, field, attackerSide: side });
      if (r.maxPercent > best) best = r.maxPercent;
    } catch { /* status / non-damaging / unresolvable → 0 */ }
  }
  return best;
}

export const FEATURE_NAMES = ['staticScore', 'netOHKO', 'netSpeed', 'netTypePressure', 'netOffense', 'netBulk'] as const;

/** Feature vector for `myBring` (4) vs `oppBring` (4). `featureNames` aligns. */
export function matchupFeatures(myBring: PokemonSet[], oppBring: PokemonSet[], field: FieldState = NEUTRAL_FIELD): number[] {
  // (0) The static maximin opening-search score — the baseline signal to calibrate.
  const input: SearchInput = {
    mine: myBring.map((set, k) => ({ set, hpPercent: 100, active: k < 2 })),
    opp: oppBring.map((set, k) => ({ entry: entryOf(set), hpPercent: 100, active: k < 2 })),
    field: { ...field }, allOppRevealed: true,
  };
  const staticScore = searchIterative(input, 2).score;

  // (1) KO race — how many of theirs my bring can OHKO (best roll) minus vice versa.
  let myOHKO = 0, oppOHKO = 0;
  for (const m of myBring) for (const o of oppBring) if (bestDamagePct(m, o, 'mine', field) >= 100) myOHKO++;
  for (const o of oppBring) for (const m of myBring) if (bestDamagePct(o, m, 'theirs', field) >= 100) oppOHKO++;

  // (2) Speed — net mean base Speed.
  const meanSpe = (br: PokemonSet[]) => br.reduce((a, s) => a + (baseStats(s.species)?.spe ?? 0), 0) / br.length;
  const netSpeed = meanSpe(myBring) - meanSpe(oppBring);

  // (3) Type pressure — Σ best-STAB effectiveness my→opp minus opp→my.
  const pressure = (atk: PokemonSet[], def: PokemonSet[]) => {
    let s = 0;
    for (const a of atk) { const at = speciesTypes(a.species); for (const d of def) { const dt = speciesTypes(d.species); s += Math.max(...at.map(t => effectiveness(t, dt))); } }
    return s;
  };
  const netTypePressure = pressure(myBring, oppBring) - pressure(oppBring, myBring);

  // (4,5) Raw stat edges.
  const off = (br: PokemonSet[]) => br.reduce((a, s) => { const b = baseStats(s.species); return a + (b ? Math.max(b.atk!, b.spa!) : 0); }, 0);
  const bulk = (br: PokemonSet[]) => br.reduce((a, s) => { const b = baseStats(s.species); return a + (b ? b.hp! + b.def! + b.spd! : 0); }, 0);

  return [
    staticScore / 1000,
    (myOHKO - oppOHKO) / 4,
    netSpeed / 100,
    netTypePressure / 16,
    (off(myBring) - off(oppBring)) / 200,
    (bulk(myBring) - bulk(oppBring)) / 300,
  ];
}
