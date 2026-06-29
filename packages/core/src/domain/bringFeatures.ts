// Engine-derived, TEAM-AGNOSTIC matchup features for the bring value model. The
// whole point (per the Step-0 finding): the static opening-search score is a
// strong but MISCALIBRATED signal — so we feed it to the model AS a feature
// alongside matchup aggregates the score can't express, and let supervised
// learning on playout outcomes calibrate/correct it. Features describe the
// MATCHUP, not team identity, so a model trained on our team vs the meta can
// generalize across opponents.
//
// v2 adds MECHANICS-AWARE features (the engine understands the mechanics; we
// expose more of that understanding rather than make the model re-learn it):
// real KO PROBABILITY from the calc's damage rolls (not a binary count), plus
// presence of the disruption/control mechanics that decide doubles games
// (Intimidate, Fake Out, redirection, Tailwind/Trick Room).
import { searchIterative, type SearchInput } from './endgameSearch.js';
import { damageRange } from './damage.js';
import { effectiveness, speciesTypes } from './typechart.js';
import { getSpecies, toId } from './data.js';
import { entryOf } from './teamSim.js';
import { NEUTRAL_FIELD, type FieldState } from './types.js';
import type { PokemonSet } from './types.js';

const baseStats = (sp: string) => (getSpecies(sp) as { baseStats?: Record<string, number> } | undefined)?.baseStats;
const hasMove = (set: PokemonSet, names: string[]) => (set.moves ?? []).some(m => names.some(n => toId(m) === toId(n)));
const hasAbility = (set: PokemonSet, name: string) => toId(set.ability ?? '') === toId(name);

// Best KO PROBABILITY this attacker can land on this defender — over its moves,
// the fraction of the calc's damage rolls that reach 100% (spread-aware: real
// sets, abilities, items). A continuous, mechanics-faithful KO-race signal.
function bestKoProb(attacker: PokemonSet, defender: PokemonSet, side: 'mine' | 'theirs', field: FieldState): number {
  let best = 0;
  for (const move of attacker.moves ?? []) {
    try {
      const r = damageRange({ attacker, defender, move, field, attackerSide: side });
      const rolls = r.percentRolls;
      if (rolls.length) { const p = rolls.filter(x => x >= 100).length / rolls.length; if (p > best) best = p; }
    } catch { /* status / non-damaging / unresolvable → 0 */ }
  }
  return best;
}

export const FEATURE_NAMES = [
  'staticScore', 'netKoProb', 'netSpeed', 'netTypePressure', 'netOffense', 'netBulk',
  'netIntimidate', 'netFakeOut', 'netRedirect', 'netSpeedControl',
] as const;

/** Feature vector for `myBring` (4) vs `oppBring` (4). `FEATURE_NAMES` aligns. */
export function matchupFeatures(myBring: PokemonSet[], oppBring: PokemonSet[], field: FieldState = NEUTRAL_FIELD): number[] {
  // (0) The static maximin opening-search score — the baseline signal to calibrate.
  const input: SearchInput = {
    mine: myBring.map((set, k) => ({ set, hpPercent: 100, active: k < 2 })),
    opp: oppBring.map((set, k) => ({ entry: entryOf(set), hpPercent: 100, active: k < 2 })),
    field: { ...field }, allOppRevealed: true,
  };
  const staticScore = searchIterative(input, 2).score;

  // (1) KO race — net summed best KO PROBABILITY across all pairs (mechanics-aware).
  let myKo = 0, oppKo = 0;
  for (const m of myBring) for (const o of oppBring) myKo += bestKoProb(m, o, 'mine', field);
  for (const o of oppBring) for (const m of myBring) oppKo += bestKoProb(o, m, 'theirs', field);

  // (2) Speed — net mean base Speed.
  const meanSpe = (br: PokemonSet[]) => br.reduce((a, s) => a + (baseStats(s.species)?.spe ?? 0), 0) / br.length;

  // (3) Type pressure — Σ best-STAB effectiveness my→opp minus opp→my.
  const pressure = (atk: PokemonSet[], def: PokemonSet[]) => {
    let s = 0;
    for (const a of atk) { const at = speciesTypes(a.species); for (const d of def) { const dt = speciesTypes(d.species); s += Math.max(...at.map(t => effectiveness(t, dt))); } }
    return s;
  };

  // (4,5) Raw stat edges.
  const off = (br: PokemonSet[]) => br.reduce((a, s) => { const b = baseStats(s.species); return a + (b ? Math.max(b.atk!, b.spa!) : 0); }, 0);
  const bulk = (br: PokemonSet[]) => br.reduce((a, s) => { const b = baseStats(s.species); return a + (b ? b.hp! + b.def! + b.spd! : 0); }, 0);

  // (6-9) Mechanics presence — net counts of the disruption/control that decide doubles.
  const countAbil = (br: PokemonSet[], ab: string) => br.filter(s => hasAbility(s, ab)).length;
  const countMove = (br: PokemonSet[], mv: string[]) => br.filter(s => hasMove(s, mv)).length;
  const netIntimidate = countAbil(myBring, 'Intimidate') - countAbil(oppBring, 'Intimidate');
  const netFakeOut = countMove(myBring, ['Fake Out']) - countMove(oppBring, ['Fake Out']);
  const netRedirect = countMove(myBring, ['Follow Me', 'Rage Powder']) - countMove(oppBring, ['Follow Me', 'Rage Powder']);
  const netSpeedControl = countMove(myBring, ['Tailwind', 'Trick Room']) - countMove(oppBring, ['Tailwind', 'Trick Room']);

  return [
    staticScore / 1000,
    (myKo - oppKo) / 4,
    (meanSpe(myBring) - meanSpe(oppBring)) / 100,
    (pressure(myBring, oppBring) - pressure(oppBring, myBring)) / 16,
    (off(myBring) - off(oppBring)) / 200,
    (bulk(myBring) - bulk(oppBring)) / 300,
    netIntimidate / 2,
    netFakeOut / 2,
    netRedirect / 2,
    netSpeedControl / 2,
  ];
}
