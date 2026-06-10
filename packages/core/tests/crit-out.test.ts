// The crit out (per-move cells stage d, defensive flavor): a forced loss whose
// only escape is crit-KOing the opp's guaranteed killer BEFORE it acts must
// demote to a hedged loss and surface "crit: X's move crit-KOs Y". The fixture
// is tuned so the kill is 100%-accurate and roll-guaranteed (the miss out can't
// demote) and my move KOs ONLY on a crit (normal max roll < foe HP ≤ crit rolls).
//
// Numbers (L50, from the calc): Timid 252 SpA Flutter Mane Moonblast vs 252 HP
// Adamant Kingambit = 46.4–55.1% (crit 69.6–82.6%) → at 60% HP only crits KO.
// Adamant 252 Atk Kingambit Kowtow Cleave vs 0/0 Flutter Mane = 101.5–120% →
// at 100% HP the kill is roll-guaranteed, 100% accurate. FM strictly outspeeds.
import { describe, test, expect } from 'vitest';
import { searchToDepth, resolveOneTurn, type SearchInput, type TurnAction } from '../src/domain/endgameSearch.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
function oppOf(set: PokemonSet): OpponentEntry {
  return { species: set.species, knownMoves: set.moves, candidates: [set], item: set.item };
}

const flutter = (item?: string) => mon({
  species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid', item,
  evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Moonblast'],
});
const kingambit = (ability = 'Defiant') => mon({
  species: 'Kingambit', ability, nature: 'Adamant',
  evs: { ...ZERO_EVS, hp: 252, atk: 252 }, moves: ['Kowtow Cleave'],
});
const position = (opts: { myItem?: string; oppAbility?: string; trickRoom?: boolean } = {}): SearchInput => ({
  mine: [{ set: flutter(opts.myItem), hpPercent: 100, active: true }],
  opp: [{ entry: oppOf(kingambit(opts.oppAbility)), hpPercent: 60, active: true }],
  field: { ...NEUTRAL_FIELD, trickRoom: opts.trickRoom ?? false },
  allOppRevealed: true,
});

describe('crit out — forced-loss demotion via crit-KO of the killer', () => {
  test('demotes forced and surfaces the crit line at the base 1/24 band', () => {
    const r = searchToDepth(position(), 2);
    expect(r.verdict).toBe('losing');
    expect(r.forced).toBe(false);                      // demoted: the killer can be crit-KO'd first
    expect(r.hailMary).toBeDefined();
    const hm = r.hailMary!;
    expect(hm.noRealisticOut).toBe(false);
    expect(hm.outs).toHaveLength(1);
    expect(hm.outs[0]!.label).toContain('crit:');
    expect(hm.outs[0]!.label).toContain('Moonblast');
    expect(hm.outs[0]!.label).toContain('Kingambit');
    // Base crit stage: 1/24 ≈ 4.2% (× P(crit roll KOs) = 1 here).
    expect(hm.combined).toBeGreaterThan(0.02);
    expect(hm.combined).toBeLessThan(0.06);
    // The out-chasing play: attack the killer with the crit move.
    expect(hm.plays).toHaveLength(1);
    expect(hm.plays[0]!.move).toBe('Moonblast');
    expect(hm.plays[0]!.targetSpecies).toBe('Kingambit');
  });

  test('Scope Lens raises the band to 1/8', () => {
    const r = searchToDepth(position({ myItem: 'Scope Lens' }), 2);
    expect(r.forced).toBe(false);
    expect(r.hailMary).toBeDefined();
    expect(r.hailMary!.combined).toBeGreaterThan(0.10);
    expect(r.hailMary!.combined).toBeLessThan(0.15);
  });

  test('no demotion when the killer acts first (Trick Room flips the order)', () => {
    // Same damage numbers; under Trick Room the slower Kingambit moves first,
    // so the crit can never deny the kill — stays a forced loss, no false hope.
    const r = searchToDepth(position({ trickRoom: true }), 2);
    expect(r.verdict).toBe('losing');
    expect(r.forced).toBe(true);
    expect(r.hailMary).toBeUndefined();
  });

  test('Shell Armor on the killer blocks the crit out', () => {
    const r = searchToDepth(position({ oppAbility: 'Shell Armor' }), 2);
    expect(r.verdict).toBe('losing');
    expect(r.forced).toBe(true);
    expect(r.hailMary).toBeUndefined();
  });
});

describe('sim-diff stage (c) mechanics (retarget / darts / Rage Fist)', () => {
  // Retarget: both my actives attack; the first KOs the shared target and the
  // second's single-target move must hit the REMAINING foe instead of fizzling.
  test('a single-target attack on a fainted foe retargets the other foe', () => {
    const fast = mon({
      species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid',
      evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Moonblast'],
    });
    const slow = mon({
      species: 'Iron Hands', ability: 'Quark Drive', nature: 'Adamant',
      evs: { ...ZERO_EVS, hp: 252, atk: 252 }, moves: ['Drain Punch'],
    });
    const frail = mon({ species: 'Dugtrio', ability: 'Sand Veil', nature: 'Jolly', evs: { ...ZERO_EVS }, moves: ['Protect'] });
    const wall = mon({ species: 'Garganacl', ability: 'Purifying Salt', nature: 'Careful', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Protect'] });
    const input: SearchInput = {
      mine: [
        { set: fast, hpPercent: 100, active: true },
        { set: slow, hpPercent: 100, active: true },
      ],
      opp: [
        { entry: oppOf(frail), hpPercent: 5, active: true },   // dies to the first hit
        { entry: oppOf(wall), hpPercent: 100, active: true },
      ],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    };
    // BOTH my actives aim at the frail foe 0; the faster one KOs it, and the
    // slower one's single-target attack must RETARGET foe 1 — not fizzle.
    const acts = new Map<number, TurnAction>([[0, { kind: 'attack', target: 0 }], [1, { kind: 'attack', target: 0 }]]);
    const r = resolveOneTurn(input, acts, new Map());
    expect(r.opp[0]!.fainted).toBe(true);
    expect(r.opp[1]!.hpPct).toBeLessThan(100);   // retargeted hit landed on the wall
  });
});
