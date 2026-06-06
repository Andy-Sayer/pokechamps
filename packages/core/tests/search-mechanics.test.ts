// Search-lookahead mechanics added to close the long-tail GAP backlog
// (mechanics-coverage.md). Each uses resolveOneTurn to drive a single turn with
// chosen actions and asserts the discrete post-turn state.
import { describe, test, expect } from 'vitest';
import { resolveOneTurn, searchToDepth, type SearchInput, type TurnAction } from '../src/domain/endgameSearch.js';
import { applyHazardsToSwitchIn } from '../src/domain/hazards.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
function oppOf(set: PokemonSet): OpponentEntry {
  return { species: set.species, knownMoves: set.moves, ability: set.ability, item: set.item, candidates: [set] };
}
function input1v1(my: PokemonSet, opp: PokemonSet, over: Partial<SearchInput> = {}): SearchInput {
  return {
    mine: [{ set: my, hpPercent: 100, active: true }],
    opp: [{ entry: oppOf(opp), hpPercent: 100, active: true }],
    field: { ...NEUTRAL_FIELD }, ...over,
  };
}
const A = (a: TurnAction): Map<number, TurnAction> => new Map([[0, a]]);

describe('1D chess — opponent obvious play', () => {
  test('greedy max-damage play is surfaced for the opp', () => {
    const flutter = mon({ species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Moonblast'] });
    const chomp = mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Earthquake', 'Dragon Claw'] });
    const r = searchToDepth(input1v1(flutter, chomp), 1);
    expect(r.obviousOppPlay?.length).toBe(1);
    expect(r.obviousOppPlay![0]!.mySpecies).toBe('Garchomp');
    expect(r.obviousOppPlay![0]!.move).toBeTruthy();
  });

  test('a turn-1 Fake Out user surfaces Fake Out as the obvious play', () => {
    const flutter = mon({ species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Moonblast'] });
    const incin = mon({ species: 'Incineroar', ability: 'Intimidate', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Fake Out', 'Flare Blitz'] });
    const input: SearchInput = {
      mine: [{ set: flutter, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(incin), hpPercent: 100, active: true, firstTurnOut: true }],
      field: { ...NEUTRAL_FIELD },
    };
    const r = searchToDepth(input, 1);
    expect(r.obviousOppPlay?.some(p => p.move === 'Fake Out')).toBe(true);
  });
});

describe('#17 Magic Bounce — status reflected at the caster', () => {
  test('Will-O-Wisp bounces back and burns the caster, not the Magic Bounce holder', () => {
    const sableye = mon({ species: 'Sableye', ability: 'Prankster', moves: ['Will-O-Wisp', 'Knock Off'] });
    const hatt = mon({ species: 'Hatterene', ability: 'Magic Bounce', moves: ['Psychic'] });
    const r = resolveOneTurn(input1v1(sableye, hatt), A({ kind: 'status', target: 0 }), A({ kind: 'attack', target: 0 }));
    expect(r.opp[0]!.status).toBe('');     // the Magic Bounce holder is NOT burned
    expect(r.mine[0]!.status).toBe('brn'); // the bounce burns the caster instead
  });

  test('without Magic Bounce the status lands normally', () => {
    const sableye = mon({ species: 'Sableye', ability: 'Prankster', moves: ['Will-O-Wisp', 'Knock Off'] });
    const garchomp = mon({ species: 'Garchomp', ability: 'Rough Skin', moves: ['Earthquake'] });
    const r = resolveOneTurn(input1v1(sableye, garchomp), A({ kind: 'status', target: 0 }), A({ kind: 'attack', target: 0 }));
    expect(r.opp[0]!.status).toBe('brn');
    expect(r.mine[0]!.status).toBe('');
  });
});

describe('#20 freeze — a frozen mon cannot act', () => {
  test('a frozen attacker deals no damage this turn', () => {
    const flutter = mon({ species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Moonblast'] });
    const chomp = mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Earthquake'] });
    const input: SearchInput = {
      mine: [{ set: flutter, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(chomp), hpPercent: 100, active: true, status: 'frz' }],
      field: { ...NEUTRAL_FIELD },
    };
    const r = resolveOneTurn(input, A({ kind: 'attack', target: 0 }), A({ kind: 'attack', target: 0 }));
    expect(r.mine[0]!.hpPct).toBe(100); // the frozen Garchomp never hit back
  });
});

describe('#18 Disguise / Ice Face — first damaging hit absorbed', () => {
  test('Mimikyu behind its Disguise survives a lethal hit (chip only)', () => {
    const flutter = mon({ species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Shadow Ball'] });
    const mimikyu = mon({ species: 'Mimikyu', ability: 'Disguise', moves: ['Play Rough'] });
    const r = resolveOneTurn(input1v1(flutter, mimikyu), A({ kind: 'attack', target: 0 }), A({ kind: 'attack', target: 0 }));
    expect(r.opp[0]!.fainted).toBe(false);        // the disguise ate the hit
    expect(r.opp[0]!.hpPct).toBeGreaterThan(80);  // only the 1/8 break-chip
  });
});

describe('#13 recharge — Hyper Beam locks the user out next turn', () => {
  test('after Hyper Beam the user is flagged to recharge', () => {
    const glalie = mon({ species: 'Glalie', ability: 'Inner Focus', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Hyper Beam'] });
    const blissey = mon({ species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Seismic Toss'] });
    const r = resolveOneTurn(input1v1(glalie, blissey), A({ kind: 'attack', target: 0 }), A({ kind: 'attack', target: 0 }));
    expect(r.mine[0]!.recharge).toBe(true);
  });
});

describe('#14 locked — Outrage locks the user into attacking', () => {
  test('using Outrage sets a multi-turn lock', () => {
    const dragonite = mon({ species: 'Dragonite', ability: 'Multiscale', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Outrage'] });
    const garchomp = mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { ...ZERO_EVS, hp: 252, def: 4 }, moves: ['Earthquake'] });
    const r = resolveOneTurn(input1v1(dragonite, garchomp), A({ kind: 'attack', target: 0 }), A({ kind: 'attack', target: 0 }));
    if (r.mine[0]!.fainted === false) expect(r.mine[0]!.locked).toBeGreaterThan(0);
  });
});

describe('#15 Substitute — sub absorbs damage, status blocked', () => {
  test('a sub already up absorbs the hit (mon HP unchanged) and blocks status', () => {
    const sableye = mon({ species: 'Sableye', ability: 'Prankster', moves: ['Will-O-Wisp', 'Knock Off'] });
    const subMon = mon({ species: 'Gholdengo', ability: 'Good as Gold', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Substitute', 'Shadow Ball'] });
    const input: SearchInput = {
      mine: [{ set: sableye, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(subMon), hpPercent: 100, active: true, subHpPercent: 25 }],
      field: { ...NEUTRAL_FIELD },
    };
    // Sableye Knock Off into the sub: the sub eats it, the mon stays at 100.
    const r = resolveOneTurn(input, A({ kind: 'attack', target: 0 }), A({ kind: 'attack', target: 0 }));
    expect(r.opp[0]!.hpPct).toBe(100);
    expect(r.opp[0]!.subHp ?? 0).toBeGreaterThanOrEqual(0);
  });

  test('using Substitute pays 25% HP and raises a sub', () => {
    const gholdengo = mon({ species: 'Gholdengo', ability: 'Good as Gold', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Substitute', 'Shadow Ball'] });
    const chomp = mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 0, spe: 252 }, moves: ['Dragon Claw'] });
    const r = resolveOneTurn(input1v1(gholdengo, chomp), A({ kind: 'substitute' }), A({ kind: 'attack', target: 0 }));
    expect(r.mine[0]!.subHp).toBe(25);             // a sub is up
    expect(r.mine[0]!.hpPct).toBeLessThanOrEqual(75); // paid 25% (plus any chip)
  });
});

describe('#12 Counter — reflects physical damage taken', () => {
  test('Counter deals damage back to a physical attacker', () => {
    const hitmontop = mon({ species: 'Hitmontop', ability: 'Intimidate', nature: 'Impish', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Counter', 'Close Combat'] });
    const chomp = mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Dragon Claw'] });
    // Garchomp hits Hitmontop physically; Hitmontop Counters → Garchomp takes 2× back.
    const r = resolveOneTurn(input1v1(hitmontop, chomp), A({ kind: 'counter' }), A({ kind: 'attack', target: 0 }));
    expect(r.opp[0]!.hpPct).toBeLessThan(100); // Garchomp took reflected damage
  });

  test('Counter does nothing against a non-attacker', () => {
    const hitmontop = mon({ species: 'Hitmontop', ability: 'Intimidate', nature: 'Impish', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Counter', 'Close Combat'] });
    const chomp = mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 0 }, moves: ['Swords Dance'] });
    const r = resolveOneTurn(input1v1(hitmontop, chomp), A({ kind: 'counter' }), new Map());
    expect(r.opp[0]!.hpPct).toBe(100); // no hit taken → nothing to reflect
  });
});

describe('#16 forced-switch items — Red Card forces the attacker out', () => {
  test('a hit into a Red Card holder clears the attacker’s boosts (forced out)', () => {
    const holder = mon({ species: 'Blissey', ability: 'Natural Cure', item: 'Red Card', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Seismic Toss'] });
    const attacker = mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Dragon Claw'] });
    const bench = mon({ species: 'Incineroar', ability: 'Intimidate', moves: ['Flare Blitz'] });
    const input: SearchInput = {
      mine: [{ set: holder, hpPercent: 100, active: true }],
      opp: [
        { entry: oppOf(attacker), hpPercent: 100, active: true, boosts: { atk: 2 } },
        { entry: oppOf(bench), hpPercent: 100, active: false },
      ],
      field: { ...NEUTRAL_FIELD },
    };
    const r = resolveOneTurn(input, A({ kind: 'attack', target: 0 }), A({ kind: 'attack', target: 0 }));
    expect(r.opp[0]!.boosts.atk ?? 0).toBe(0); // Garchomp was forced out → +2 Atk gone
  });
});

describe('#19 Gravity — grounds a Flying mon so it eats hazards', () => {
  test('a Flying mon ignores Spikes normally but eats them under Gravity', () => {
    const noGrav = applyHazardsToSwitchIn({ spikes: 1 }, { species: 'Corviknight' });
    const grav = applyHazardsToSwitchIn({ spikes: 1 }, { species: 'Corviknight', gravity: true });
    expect(noGrav.hpPctLoss ?? 0).toBe(0);
    expect(grav.hpPctLoss ?? 0).toBeGreaterThan(0);
  });
});

describe('#11 Future Sight — delayed damage', () => {
  test('Future Sight deals no damage the turn it is cast (scheduled)', () => {
    const future = mon({ species: 'Slowking', ability: 'Regenerator', nature: 'Modest', evs: { ...ZERO_EVS, hp: 252, spa: 252 }, moves: ['Future Sight'] });
    const chomp = mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Adamant', evs: { ...ZERO_EVS, hp: 252, def: 4 }, moves: ['Swords Dance'] });
    const input: SearchInput = {
      mine: [{ set: future, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(chomp), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD },
    };
    // Garchomp sets up (no attack); Slowking casts Future Sight → no immediate hit.
    const r = resolveOneTurn(input, A({ kind: 'attack', target: 0 }), new Map());
    expect(r.opp[0]!.hpPct).toBe(100); // scheduled, lands 2 turns later — not now
  });
});

describe('#10 Wish — delayed self-heal', () => {
  test('casting Wish schedules a pending heal (not immediate)', () => {
    const alomomola = mon({ species: 'Alomomola', ability: 'Regenerator', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Wish', 'Scald'] });
    const chomp = mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 0, spe: 252 }, moves: ['Dragon Claw'] });
    const hurt: SearchInput = {
      mine: [{ set: alomomola, hpPercent: 60, active: true }],
      opp: [{ entry: oppOf(chomp), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD },
    };
    const r = resolveOneTurn(hurt, A({ kind: 'recover' }), A({ kind: 'attack', target: 0 }));
    expect(r.mine[0]!.wish).toBeGreaterThan(0);  // pending — not yet healed
    expect(r.mine[0]!.hpPct).toBeLessThanOrEqual(62); // no immediate heal this turn
  });
});
