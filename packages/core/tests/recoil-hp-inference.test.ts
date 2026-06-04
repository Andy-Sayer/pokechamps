import { describe, test, expect } from 'vitest';
import { parseTurnLine, type ParseContext } from '../src/domain/turnparser.js';
import { solveOppMaxHp, hpEvsForMaxHp, recoilDrainHpEvs } from '../src/domain/inference.js';
import { maxHpFor } from '../src/domain/damage.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

const my: PokemonSet[] = [
  { species: 'Talonflame', level: 50, nature: 'Adamant', evs: { ...ZERO_EVS }, ivs: MAX_IVS, moves: ['Brave Bird'] },
  { species: 'Garchomp', level: 50, nature: 'Jolly', evs: { ...ZERO_EVS }, ivs: MAX_IVS, moves: ['Liquidation'] },
];
const opp: OpponentEntry[] = [
  { species: 'Garchomp', knownMoves: [] },
  { species: 'Incineroar', knownMoves: [] },
];
const ctx: ParseContext = { myTeam: my, opponentTeam: opp, myActiveTeamIndex: [0, 1], theirActiveTeamIndex: [0, 1] };

describe('turn parser: `/ <selfHP> [source]` clause', () => {
  test('opp recoil → % on the opp bar; target damage still parsed', () => {
    const r = parseTurnLine('o1 > Brave Bird > m1 > 45 / 89', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    expect(r.actions[0]!.selfRemainingHpPercent).toBe(89);   // o1 = opp → %
    expect(r.actions[0]!.selfHpSource).toBeUndefined();        // bare = move's recoil
    expect(r.actions[0]!.targetRemainingHpRaw).toBe(45);      // m1 = mine target → raw
  });

  test('my recoil → raw on my bar', () => {
    const r = parseTurnLine('m1 > Brave Bird > o1 > 50 / 120', ctx, 1);
    if (!r.ok || r.kind !== 'action') return;
    expect(r.actions[0]!.selfRemainingHpRaw).toBe(120);
  });

  test('helmet source tag', () => {
    const r = parseTurnLine('m2 > Liquidation > o1 > 50 / 84 helmet', ctx, 1);
    if (!r.ok || r.kind !== 'action') return;
    expect(r.actions[0]!.selfRemainingHpRaw).toBe(84);
    expect(r.actions[0]!.selfHpSource).toBe('helmet');
  });
});

describe('recoil/drain → opponent max-HP solver', () => {
  const garchompHp = (hp: number): PokemonSet =>
    ({ species: 'Garchomp', level: 50, nature: 'Hardy', evs: { ...ZERO_EVS, hp }, ivs: MAX_IVS, moves: [] });

  test('hpEvsForMaxHp round-trips an HP EV', () => {
    expect(hpEvsForMaxHp('Garchomp', 50, maxHpFor(garchompHp(252)))).toContain(252);
    expect(hpEvsForMaxHp('Garchomp', 50, maxHpFor(garchompHp(0)))).toContain(0);
  });

  test('reads the opp HP EV from an OPP recoil (case A)', () => {
    const oppMaxTrue = maxHpFor(garchompHp(252));
    const myMaxHp = 200, targetDrop = 0.5;
    const recoilFracOfOpp = (0.33 * targetDrop * myMaxHp) / oppMaxTrue; // recoil = 33% of damage to my mon
    const evs = recoilDrainHpEvs({
      effect: 'recoil', frac: 0.33, oppIsAttacker: true, oppSpecies: 'Garchomp', oppLevel: 50,
      attackerBeforeFrac: 1, attackerAfterFrac: 1 - recoilFracOfOpp, attackerFainted: false,
      peelFrac: 0, targetDropFrac: targetDrop, knownMaxHp: myMaxHp,
    });
    expect(evs).toContain(252);
  });

  test('reads the opp HP EV from MY recoil (case B)', () => {
    const oppMaxTrue = maxHpFor(garchompHp(252));
    const myMaxHp = maxHpFor({ species: 'Talonflame', level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, moves: [] });
    const targetDrop = 0.4;
    const myRecoilFrac = (0.33 * targetDrop * oppMaxTrue) / myMaxHp;
    const evs = recoilDrainHpEvs({
      effect: 'recoil', frac: 0.33, oppIsAttacker: false, oppSpecies: 'Garchomp', oppLevel: 50,
      attackerBeforeFrac: 1, attackerAfterFrac: 1 - myRecoilFrac, attackerFainted: false,
      peelFrac: 0, targetDropFrac: targetDrop, knownMaxHp: myMaxHp,
    });
    expect(evs).toContain(252);
  });

  test('peels Rocky Helmet (1/6) before solving the recoil', () => {
    const oppMaxTrue = maxHpFor(garchompHp(252));
    const myMaxHp = 200, targetDrop = 0.5;
    const recoilFracOfOpp = (0.33 * targetDrop * myMaxHp) / oppMaxTrue;
    const evs = recoilDrainHpEvs({
      effect: 'recoil', frac: 0.33, oppIsAttacker: true, oppSpecies: 'Garchomp', oppLevel: 50,
      attackerBeforeFrac: 1, attackerAfterFrac: 1 - recoilFracOfOpp - 1 / 6, attackerFainted: false,
      peelFrac: 1 / 6, targetDropFrac: targetDrop, knownMaxHp: myMaxHp,
    });
    expect(evs).toContain(252);
  });

  test('abstains when the attacker fainted (truncated HP, no clean reading)', () => {
    expect(recoilDrainHpEvs({
      effect: 'recoil', frac: 0.33, oppIsAttacker: true, oppSpecies: 'Garchomp', oppLevel: 50,
      attackerBeforeFrac: 1, attackerAfterFrac: 0, attackerFainted: true,
      peelFrac: 0, targetDropFrac: 0.5, knownMaxHp: 200,
    })).toEqual([]);
  });

  test('drain reads HP too, but abstains when the heal overcapped', () => {
    expect(recoilDrainHpEvs({
      effect: 'drain', frac: 0.5, oppIsAttacker: true, oppSpecies: 'Garchomp', oppLevel: 50,
      attackerBeforeFrac: 0.9, attackerAfterFrac: 1, attackerFainted: false, // healed to full → capped
      peelFrac: 0, targetDropFrac: 0.5, knownMaxHp: 200,
    })).toEqual([]);
  });

  test('solveOppMaxHp is defense-independent (pure arithmetic)', () => {
    // opp attacker: oppMax = recoilFrac·known·targetDrop / selfFrac
    expect(solveOppMaxHp({ oppIsAttacker: true, recoilFrac: 0.33, attackerSelfFrac: 0.165, targetDropFrac: 0.5, knownMaxHp: 200 }))
      .toBeCloseTo(200, 0); // 0.33·200·0.5/0.165 = 200
  });
});
